require('isomorphic-fetch')
const {
  BaseKonnector,
  requestFactory,
  log,
  cozyClient,
  errors,
  utils
} = require('cozy-konnector-libs')
let request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true
})
const moment = require('moment')

module.exports = new BaseKonnector(start)

async function start(fields) {
  request = request.defaults({
    auth: {
      bearer: fields.access_token
    }
  })

  await checkToken.bind(this)(fields)

  const user = await request(
    'https://api.orange.com/userdetails/fr/v2/userinfo/'
  )

  const response = await fetchBills(fields)
  user.contract_type = response.customer_bills[0].contract_type

  await formatAndSaveIdentity.bind(this)(user, fields)

  const bills = response.customer_bills.map(bill => {
    return {
      filename:
        bill.contract_type === 'mobile'
          ? `${utils.formatDate(bill.creation_date)}_facture_mobile.pdf`
          : `${utils.formatDate(bill.creation_date)}_facture_internet.pdf`,
      filestream: bill.file,
      vendor: 'Orange',
      date: new Date(bill.creation_date)
    }
  })

  await this.saveBills(bills, fields, {
    sourceAccountIdentifier: user.email,
    identifiers: ['orange'],
    contentType: 'application/pdf; charset=IBM850',
    processPdf: (entry, text, cells) => {
      const dateIndex = cells['1'].findIndex(
        cell => cell.str === 'total du montant prélevé'
      )
      const date = moment(
        cells['1'][dateIndex + 1].str.replace('au ', ''),
        'DD.MM.YYYY'
      )

      const top =
        cells['1'][dateIndex].transform.pop() + cells['1'][dateIndex].height
      const bottom = cells['1'][dateIndex + 1].transform.pop()

      const amountCell = cells['1'].find(cell => {
        const cellBottom = cell.transform.pop()
        const cellTop = cellBottom + cell.height
        return (
          cellBottom > bottom &&
          cellTop < top &&
          parseFloat(
            cell.str
              .replace('€', '')
              .replace(',', '.')
              .trim()
          )
        )
      })

      const amount = parseFloat(
        amountCell.str
          .replace(',', '.')
          .replace('€', '')
          .trim()
      )

      entry.date = date.toDate()
      entry.amount = amount

      log('info', 'resulting entry')
      log('info', JSON.stringify(entry))
      return entry
    }
  })
}

function parseFile(file) {
  const result = {}
  const [headers, ...body] = file
    .trim()
    .split('\n\n')
    .filter(item => item.length)
  result.headers = parseHeaders(headers)
  result.file = body.join('\n\n')
  return result
}

function parseHeaders(strHeaders) {
  return strHeaders
    .trim()
    .split('\n')
    .reduce((memo, line) => {
      const [key, value] = line.split(':')
      memo[key.trim()] = value.trim()
      return memo
    }, {})
}

async function fetchBills(fields) {
  const resp = await request(
    'https://api.orange.com/customerbill/fr/v1/premiuminfo',
    {
      auth: {
        bearer: fields.access_token
      },
      headers: {
        Accept: 'multipart/related'
      },
      resolveWithFullResponse: true
    }
  )

  // parse content-type header to find file ids
  let [, ...fullContentType] = resp.headers['content-type']
    .split(';')
    .map(item => item.trim())
    .slice(0, -1)
  fullContentType = fullContentType.reduce((memo, item) => {
    let [key, ...value] = item.split('=')
    value = value.join('=')
    memo[key] = value.slice(1, -1)
    return memo
  }, {})

  // split response to find files in it
  const boundary = fullContentType.boundary
  let files = resp.body
    .trim()
    .split('--' + boundary + '\n')
    .slice(1)

  // index files by content id
  files = files.map(parseFile).reduce((memo, item) => {
    const cid = item.headers['Content-ID']
    memo[cid] = item
    return memo
  }, {})

  // response if the first file which is json
  const response = JSON.parse(files[fullContentType.start].file)

  response.customer_bills = response.customer_bills.map(bill => {
    bill.file = files['<' + bill.file_id.split(':').pop() + '>'].file
    return bill
  })

  return response
}

async function formatAndSaveIdentity(user, fields) {
  this._account = await ensureAccountNameAndFolder(this._account, fields, user)

  if (user.email) {
    const ident = {
      identifier: user.email,
      contact: {
        email: [
          {
            address: user.email
          }
        ],
        name: {
          familyName: user.family_name,
          givenName: user.given_name
        },
        phone: [
          {
            number: user.phone_number,
            primary: true,
            type: 'mobile'
          }
        ]
      }
    }

    if (user.address) {
      ident.contact.address = [
        {
          formattedAddress: user.address.formatted.replace(/\r\n|\n/g, ' '),
          street: user.address.street_address.replace(/\r\n|\n/g, ' '),
          postcode: user.address.postal_code,
          city: user.address.locality
        }
      ]
    }

    await this.saveIdentity(ident.contact, ident.identifier)
    const meContacts = await utils.queryAll('io.cozy.contacts', { me: true })
    if (meContacts.length === 0) {
      log('info', `The "me" contact could not be found, creating it`)
      await this.updateOrCreate(
        [{ ...ident.contact, me: true }],
        'io.cozy.contacts',
        ['me']
      )
    } else {
      log('info', `Found a "me" contact. Nothing to do`)
    }
  }
}

async function ensureAccountNameAndFolder(account, fields, user) {
  const firstRun = !account || !account.label

  if (!firstRun) {
    return
  }

  try {
    log('info', `This is the first run`)
    const label = `${user.name} ${
      user.contract_type === 'mobile' ? 'Mobile' : 'Internet'
    }`

    log('info', `Updating the label of the account`)
    let newAccount = await cozyClient.data.updateAttributes(
      'io.cozy.accounts',
      account._id,
      {
        label,
        auth: {
          ...account.auth,
          accountName: label
        }
      }
    )

    log('info', `Renaming the folder to ${label}`)
    const newFolder = await cozyClient.files.updateAttributesByPath(
      fields.folderPath,
      {
        name: label
      }
    )

    fields.folderPath = newFolder.attributes.path

    log('info', `Updating the folder path in the account`)
    newAccount = await cozyClient.data.updateAttributes(
      'io.cozy.accounts',
      newAccount._id,
      {
        label,
        auth: {
          ...newAccount.auth,
          folderPath: fields.folderPath,
          namePath: label
        }
      }
    )
    return newAccount
  } catch (err) {
    log(
      'warn',
      `Error while trying to update folder path or account name: ${err.message}`
    )
  }
}

async function checkToken(fields) {
  try {
    log('info', 'checking token')
    await request('https://api.orange.com/userdetails/fr/v2/userinfo/')
    log('info', 'token ok')
  } catch (err) {
    if (err.statusCode === 401) {
      try {
        const body = await cozyClient.fetchJSON(
          'POST',
          `/accounts/orangeapi/${this.accountId}/refresh`
        )
        fields.access_token = body.attributes.oauth.access_token
        log('info', `access_token refresh ok`)
      } catch (err) {
        log('info', `Error during refresh ${err.message}`)
        throw errors.USER_ACTION_NEEDED_OAUTH_OUTDATED
      }
    }
  }
}
