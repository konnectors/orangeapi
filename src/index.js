const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log,
  cozyClient
  // manifest
} = require('cozy-konnector-libs')
let request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true
})
const moment = require('moment')
const { Document } = require('cozy-doctypes')

module.exports = new BaseKonnector(start)

async function start(fields) {
  request = request.defaults({
    auth: {
      bearer: fields.access_token
    }
  })
  await saveIdentity.bind(this)()
  const response = await fetchBills(fields)
  const bills = response.customer_bills.map(bill => {
    const date = moment(bill.creation_date).format('DD_MM_YYYY')
    return {
      filename:
        bill.contract_type === 'mobile'
          ? `facture_mobile_${date}.pdf`
          : `facture_internet_${date}.pdf`,
      filestream: bill.file,
      vendor: 'Orange',
      date: new Date(bill.creation_date)
    }
  })

  await saveBills(bills, fields, {
    identifiers: ['orange'],
    contentType: 'application/pdf; charset=IBM850',
    processPdf: (entry, text, cells) => {
      const euroIndex = cells['1'].findIndex(cell => cell.str === '€')
      const amount = parseFloat(cells['1'][euroIndex - 2].str.replace(',', '.'))
      if (amount) {
        entry.amount = amount
      } else {
        log('warn', `Could not find an amount in this file ${entry.filename}`)
        return false
      }
      const dateIndex = cells['1'].findIndex(
        cell => cell.str === 'total du montant prélevé'
      )
      const date = moment(
        cells['1'][dateIndex + 1].str.replace('au ', ''),
        'DD.MM.YYYY'
      )
      if (moment.isDate(date)) {
        entry.date = date.toDate()
      }

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

async function saveIdentity() {
  class Identity extends Document {
    static addCozyMetadata(attributes) {
      super.addCozyMetadata(attributes)

      Object.assign(attributes.cozyMetadata, {
        doctypeVersion: 1,
        createdAt: new Date(),
        // createdByAppVersion: manifest.version,
        sourceAccount: Identity.accountId
      })

      return attributes
    }
  }
  Identity.doctype = 'io.cozy.identities'
  Identity.idAttributes = ['identifier', 'cozyMetadata.sourceAccount']
  // Identity.createdByApp = manifest.slug
  Identity.registerClient(cozyClient)
  Identity.accountId = this._account._id

  const user = await request(
    'https://api.orange.com/userdetails/fr/v2/userinfo/'
  )

  const ident = {
    identifier: user.email,
    contact: {
      email: {
        address: user.email
      },
      name: {
        familyName: user.family_name,
        givenName: user.given_name
      },
      phone: {
        number: user.phone_number,
        primary: true,
        type: 'mobile'
      }
    }
  }

  if (user.address) {
    ident.contact.address = {
      formattedAddress: user.address.formatted,
      street: user.address.street_address,
      postcode: user.address.postal_code,
      city: user.address.locality
    }
  }

  await Identity.createOrUpdate(ident)

  // also save to the me contact doctype
  Identity.doctype = 'io.cozy.contacts'
  Identity.idAttributes = ['me']
  // Identity.createdByApp = manifest.slug
  Identity.accountId = this._account._id
  await Identity.createOrUpdate({ ...ident.contact, me: true })
}
