'use strict'

const {google} = require('googleapis')
const {getAuth} = require('./auth')
const list = require('./list')
const log = require('./logger')

const configuredDriveId = process.env.DRIVE_ID

exports.run = async (query, driveType = 'team') => {
  const authClient = await getAuth()
  let folderIds

  const drive = google.drive({version: 'v3', auth: authClient})

  if (driveType === 'folder') {
    folderIds = await getAllFolders({drive})
  }

  let files = []
  
  if (driveType === 'org') { 
    const drives = Object.keys(list.getOrgDrives())
    for (var d = 0; d < drives.length; d++) {
      const driveSearch = await fullSearch({drive, query, folderIds, driveType, searchDriveId: drives[d]})
        .catch((err) => {
          log.error(`Error when searching for ${query}, ${err}`)
          throw err
        })
      files = files.concat(driveSearch)
    }
  } else { 
    files = await fullSearch({drive, query, folderIds, driveType})
    .catch((err) => {
      log.error(`Error when searching for ${query}, ${err}`)
      throw err
    })
  }

  const fileMetas = files
    .map((file) => { return list.getMeta(file.id) || {} })
    .filter(({path, tags}) => (path || '').split('/')[1] !== 'trash' && !(tags || []).includes('hidden'))

  return fileMetas
}

async function fullSearch({drive, query, folderIds, results = [], nextPageToken: pageToken, driveType, searchDriveId = configuredDriveId}) {
  const options = getOptions(query, folderIds, driveType, searchDriveId)

  if (pageToken) {
    options.pageToken = pageToken
  }

  const {data} = await drive.files.list(options)

  const {files, nextPageToken} = data
  const total = results.concat(files)

  if (nextPageToken) {
    return fullSearch({drive, query, results: total, nextPageToken, folderIds, driveType, searchDriveId})
  }

  log.debug(total.length)
  return total
}

// Grab all folders in directory to search through in shared drive
async function getAllFolders({nextPageToken: pageToken, drive, parentIds = [configuredDriveId], foldersSoFar = []} = {}) {
  const options = {
    q: `(${parentIds.map((id) => `'${id}' in parents`).join(' or ')}) AND mimeType = 'application/vnd.google-apps.folder'`,
    fields: 'files(id,name,mimeType,parents)'
  }

  if (pageToken) {
    options.pageToken = pageToken
  }

  const {data} = await drive.files.list(options)

  const {files, nextPageToken} = data
  const combined = foldersSoFar.concat(files)

  if (nextPageToken) {
    return getAllFolders({
      nextPageToken,
      foldersSoFar: combined,
      drive
    })
  }

  const folders = combined.filter((item) => parentIds.includes(item.parents[0]))

  if (folders.length > 0) {
    return getAllFolders({
      foldersSoFar: combined,
      drive,
      parentIds: folders.map((folder) => folder.id)
    })
  }

  return combined.map((folder) => folder.id)
}

function getOptions(query, folderIds, driveType, driveId = configuredDriveId) {
  const fields = '*'

  if (driveType === 'folder') {
    const parents = folderIds.map((id) => `'${id}' in parents`).join(' or ')
    return {
      q: `(${parents}) AND fullText contains ${JSON.stringify(query)} AND mimeType != 'application/vnd.google-apps.folder' AND trashed = false`,
      fields
    }
  }

  return {
    q: `fullText contains ${JSON.stringify(query)} AND mimeType != 'application/vnd.google-apps.folder' AND trashed = false`,
    teamDriveId: driveId,
    corpora: 'teamDrive',
    supportsTeamDrives: true,
    includeTeamDriveItems: true,
    fields
  }
}
