const opn = require('opn')
const fs = require('fs')
const querystring = require('querystring')
const http = require('http')
const url = require('url')
const request = require('request-promise')
const args = process.argv.slice(2)
// require('request-debug')(request)

// get scope from the manifest
const { scope } = JSON.parse(fs.readFileSync('./manifest.konnector')).oauth
// get secret data from konnector-dev-config
const {
  auth_endpoint,
  client_id,
  client_secret,
  token_endpoint,
  grant_mode
} = JSON.parse(fs.readFileSync('./konnector-dev-config.json')).oauth

function getCode() {
  return new Promise((resolve, reject) => {
    const server = http
      .createServer(async (req, res) => {
        if (req.url.indexOf('/oauth2callback') > -1) {
          const { code } = querystring.parse(url.parse(req.url).query)
          res.end(
            `Authentication successful! Please return to the console. [code: ${code}]`
          )
          server.close()
          resolve(code)
        }
        reject(new Error('oops', req, res))
      })
      .listen(3000, () => {
        opn(
          `${auth_endpoint}?${querystring.stringify({
            scope,
            response_type: 'code',
            client_id,
            state: Date.now(),
            redirect_uri: 'http://cozy.tools:3000/oauth2callback'
          })}`,
          { wait: false }
        )
      })
  })
}

async function getTokens(code) {
  return request
    .post(token_endpoint, {
      form: {
        grant_type: grant_mode,
        code,
        redirect_uri: 'http://cozy.tools:3000/oauth2callback'
      },
      json: true
    })
    .auth(client_id, client_secret)
}

function getImportedData() {
  const importedData = JSON.parse(fs.readFileSync('./data/importedData.json'))
  importedData['io.cozy.accounts'] = importedData['io.cozy.accounts'] || []
  importedData['io.cozy.accounts'][0] = importedData['io.cozy.accounts'][0] || {
    _id: 'default_account_id',
    oauth: {}
  }
  return importedData
}

function saveImportedData(data) {
  fs.writeFileSync('./data/importedData.json', JSON.stringify(data, null, 2))
}

function saveTokens(tokens) {
  const importedData = getImportedData()
  importedData['io.cozy.accounts'][0].oauth = tokens
  saveImportedData(importedData)
}

async function refreshTokens() {
  const importedData = getImportedData()
  const currentTokens = importedData['io.cozy.accounts'][0].oauth
  const newTokens = await request
    .post(token_endpoint, {
      form: {
        grant_type: 'refresh_token',
        scope,
        refresh_token: currentTokens.refresh_token,
        redirect_uri: 'http://cozy.tools:3000/oauth2callback'
      },
      json: true
    })
    .auth(client_id, client_secret)
  importedData['io.cozy.accounts'][0].oauth = newTokens
  saveImportedData(importedData)
}

async function start() {
  if (args[0] === '--refresh') {
    return refreshTokens()
  }
  const code = await getCode()
  const tokens = await getTokens(code)

  saveTokens(tokens)
}

start()
