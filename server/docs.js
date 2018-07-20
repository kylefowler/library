'use strict'

const async = require('async')
const {google} = require('googleapis')
const cheerio = require('cheerio')
const slugify = require('slugify')
const xlsx = require('xlsx')
const inflight = require('inflight')

const {getAuth} = require('./auth')
const log = require('./logger')
const list = require('./list')
const {stringTemplate} = require('./utils')

const formatterV3 = require('./formatter')
const formatterV4 = require('./formatter-beta')

const supportedTypes = new Set(['document', 'spreadsheet', 'text/html'])

exports.cleanName = (name = '') => {
  return name
    .trim()
    .replace(/^\d+[-–—_\s]*/, '') // remove leading numbers and delimiters
    .replace(/\s*\|\s*([^|]+)$/i, '')
    .replace(/\W+home$/i, '')
    .replace(/\.[^.]+$/, '') // remove file extensions
}

exports.slugify = (text = '') => {
  // convert non alpha numeric into whitespace, rather than removing
  const alphaNumeric = text.replace(/[^\w\d]/g, ' ')
  return slugify(alphaNumeric, {
    lower: true
  })
}

exports.fetchDoc = async ({id, resourceType, req}, cb) => {
  if (req.useBeta) log.debug('Using beta formatter')
  const formatter = req.useBeta ? formatterV4 : formatterV3

  cb = inflight(id, cb)
  if (!cb) return

  const auth = await getAuth()
    .catch(cb)

  fetch({id, resourceType, req}, auth, (err, html, originalRevision) => {
    if (err) return cb(err)
    html = formatter.getProcessedHtml(html)
    const sections = getSections(html)
    // maybe we should pull out headers here
    cb(err, {html, originalRevision, sections, template: stringTemplate})
  })
}

exports.fetchByline = (html, creatorOfDoc) => {
  let byline = creatorOfDoc
  const $ = cheerio.load(html)

  // Iterates through all p tags to find byline
  $('p').each((index, p) => {
    // don't search any empty p tags
    if (p.children.length < 1) return

    // regex that checks for byline
    const r = /^by.+[^.\n]$/mig
    if (r.test(p.children[0].data)) {
      byline = p.children[0].data
      // Removes the word "By"
      byline = byline.slice(3)
      $(p).remove()
    }

    // only check the first p tag
    return false
  })

  return {
    byline,
    html: $.html()
  }
}

function fetch({id, resourceType, req}, authClient, cb) {
  const drive = google.drive({version: 'v3', auth: authClient})
  async.parallel([
    (cb) => {
      if (!supportedTypes.has(resourceType)) {
        return cb(null, `Library does not support viewing ${resourceType}s yet.`)
      }

      if (resourceType === 'spreadsheet') {
        return fetchSpreadsheet(drive, id, cb)
      }

      if (resourceType === 'text/html') {
        return fetchHTML(drive, id, cb)
      }

      if (req.useBeta) {
        google.discoverAPI(`***REMOVED***${process.env.API_KEY}`)
          .then((docs) => {
            docs.documents.get({
              name: `documents/${id}`
            }, (err, {data}) => {
              cb(err, data)
            })
          })
      } else {
        drive.files.export({
          fileId: id,
          // text/html exports are not suupported for slideshows
          mimeType: resourceType === 'presentation' ? 'text/plain' : 'text/html'
        }, (err, {data}) => cb(err, data)) // this prevents receiving an array (?)
      }
    },
    (cb) => {
      const revisionSupported = new Set(['document', 'spreadsheet', 'presentation'])
      if (!revisionSupported.has(resourceType)) {
        log.info(`Revision data not supported for ${resourceType}:${id}`)
        return cb(null, {
          data: { lastModifyingUser: {} }
        }) // return mock/empty revision object
      }
      drive.revisions.get({
        fileId: id,
        revisionId: '1',
        fields: '*'
      }, (err, data) => {
        // suppress revision history errors, but log them for later
        if (err) {
          log.warn(`Failed retrieving revision data for ${resourceType}:${id}. Error was:`, err)
          return cb(null, {
            data: { lastModifyingUser: {} }
          }) // return mock/empty revision object
        }

        cb(err, data)
      })
    }
  ], (err, [html, originalRevision]) => {
    cb(err, html, originalRevision)
  })
}

function fetchSpreadsheet(drive, id, cb) {
  drive.files.export({
    fileId: id,
    // for mimeTypes see https://developers.google.com/drive/v3/web/manage-downloads#downloading_google_documents
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }, {
    // HTML export for sheets is limiting. Instead, download as a buffer and use
    // the xlsx library to parse the contents of the file and convert to HTML.
    responseType: 'arraybuffer'
  }, (err, {data}) => {
    if (err) return cb(err)

    const spreadsheet = xlsx.read(data, {type: 'buffer'})
    const {SheetNames, Sheets} = spreadsheet

    // produce some html now since we got back and xls
    const html = SheetNames.map((name) => {
      const data = Sheets[name]
      // get base html from xlsx
      const base = xlsx.utils.sheet_to_html(data)
      // manipulate with cheerio
      const $ = cheerio.load(base)
      const table = $('table')
      // add header styles
      const firstRow = $('table tr:first-of-type')
      const withHeader = firstRow.html().replace(/(<\/?)td(\s+|>)/ig, '$1th$2')
      firstRow.html(withHeader)
      // determine the last row and remove all rows after that
      const max = Object.keys(data)
        .filter((key) => key.slice(0, 1) !== '!') // ignore special rows in the sheet
        .reduce((memo, cell) => {
          const row = cell.match(/\d+/)
          const value = parseInt(row, 10)
          return value > memo ? value : memo
        }, 0)
      // remove any extra rows at the bottom of the sheet
      $(`table tr:nth-of-type(n + ${max + 1})`).remove()

      // spreadsheet names become h1 for TOC
      const slug = slugify(name)
      return [`<h1 id="${slug}">${name}</h1>`, '<table>', table.html(), '</table>'].join('\n')
    }, []).join('\n')

    // expected to be an array because of the way the google api works
    cb(null, html)
  })
}

// returns raw html from the drive
function fetchHTML(drive, id, cb) {
  drive.files.get({
    fileId: id,
    supportsTeamDrives: true,
    alt: 'media'
  }, (err, {data}) => {
    cb(err, data)
  })
}

function getSections(html) {
  const $ = cheerio.load(html)
  const headers = ['h1', 'h2']
    .map((h) => `body ${h}`)
    .join(', ')

  const ordered = $(headers).map((i, el) => {
    const tag = el.name
    const $el = $(el)
    const name = $el.text()
    const url = `#${$el.attr('id')}`
    return {
      name,
      url,
      level: parseInt(tag.slice(-1), 10)
    }
  }).toArray()

  // take our ordered sections and turn them into appropriately nested headings
  const nested = ordered.reduce((memo, heading) => {
    const tail = memo.slice(-1)[0]
    const extended = Object.assign({}, heading, {subsections: []})
    if (!tail || heading.level <= tail.level) {
      return memo.concat(extended)
    }

    tail.subsections.push(heading)
    return memo
  }, [])

  return nested
}
