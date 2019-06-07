'use strict'

const inflight = require('promise-inflight')
const {google} = require('googleapis')
const path = require('path')
const url = require('url')

const cache = require('./cache')
const log = require('./logger')
const {getAuth} = require('./auth')
const {isSupported} = require('./utils')
const docs = require('./docs')

const driveType = process.env.DRIVE_TYPE
const driveId = process.env.DRIVE_ID
const driveOrgName = process.env.DRIVE_ORG_NAME

let availableTrees = null // current route data by slug
let docsInfo = {} // doc info by id
let tags = {} // tags to doc id
let driveBranches = {} // map of id to nodes
const playlistInfo = {} // playlist info by id
const orgDrives = {}

exports.getTree = async () => {
  if (availableTrees) {
    return availableTrees[0]
  }
  await updateTree()
}

exports.getAllTrees = async () => {
  if (!availableTrees) {
    await updateTree()
  }
  return availableTrees
}

exports.getTreeForDriveSlug = async (id) => {
  if (!availableTrees) {
    await updateTree()
  }
  const drives = Object.values(orgDrives).map((d) => docs.cleanName(docs.slugify(d.name)))
  return availableTrees[drives.indexOf(id)]
}

exports.hasDrive = (slug) => {
  return Object.values(orgDrives).filter((d) => docs.cleanName(docs.slugify(d.name)) === slug).length > 0
}

// exposes docs metadata
exports.getMeta = (id) => {
  return docsInfo[id]
}

exports.getOrgDrives = () => orgDrives

exports.getDocsInfo = () => docsInfo

// returns all tags currently parsed from docs, by sort field
exports.getTagged = (tag) => {
  if (tag) return tags[tag] || []

  return tags
}

exports.getChildren = (id) => {
  return driveBranches[id]
}

exports.getPlaylist = async (id) => {
  if (playlistInfo[id]) return playlistInfo[id]

  const playlistData = await retrievePlaylistData(id)
  return playlistData
}

exports.getAllRoutes = () => {
  return Object.values(docsInfo)
    .filter(({path}) => path && path.slice(0, 1) === '/')
    .reduce((urls, {path}) => {
      return urls.add(path)
    }, new Set())
}

// delay in ms, 15s default with env var
const treeUpdateDelay = parseInt(process.env.LIST_UPDATE_DELAY || 15, 10) * 1000
startTreeRefresh(treeUpdateDelay)

async function updateTree() {
  return inflight('tree', async () => {
    const authClient = await getAuth()

    const drive = google.drive({version: 'v3', auth: authClient})
    
    if (driveType == 'org') {
      const driveFileMapping = await listDrives({drive, driveType})
      const trees = produceTree(driveFileMapping)
      availableTrees = trees
    } else {
      const files = await fetchAllFiles({drive, driveType, parentIds: [driveId]})
      const dummy = {}
      dummy[driveId] = files
      availableTrees = produceTree(dummy)
    }

    const count = Object.values(docsInfo)
      .filter((f) => f.resourceType !== 'folder')
      .length

    log.debug(`Current file count in drive: ${count}`)

    return availableTrees
  })
}

function getOptions(id) {
  const fields = 'nextPageToken,files(id,name,mimeType,parents,webViewLink,createdTime,modifiedTime,lastModifyingUser)'

  if (driveType === 'folder') {
    return {
      q: id.map((id) => `'${id}' in parents`).join(' or '),
      fields
    }
  }

  return {
    teamDriveId: id,
    q: 'trashed = false',
    corpora: 'teamDrive',
    supportsTeamDrives: true,
    includeTeamDriveItems: true,
    // fields: '*', // setting fields to '*' returns all fields but ignores pageSize
    pageSize: 1000, // this value does not seem to be doing anything
    fields
  }
}

async function listDrives({nextPageToken: pageToken, driveType = 'team', drive} = {}) {
  const {data} = await drive.teamdrives.list();

  const {teamDrives, nextPageToken} = data;

  const driveFiles = {}
  for (var i = 0; i < teamDrives.length; i++) {
    const id = teamDrives[i].id

    orgDrives[id] = teamDrives[i]
    driveFiles[id] = await fetchAllFiles({drive, driveType, parentIds: [id]})
  }

  return driveFiles
}

async function fetchAllFiles({nextPageToken: pageToken, parentIds, listSoFar = [], driveType = 'team', drive} = {}) {
  const options = getOptions(parentIds)
  if (pageToken) {
    options.pageToken = pageToken
  }

  log.debug(`searching for files > ${listSoFar.length}`)

  // Gets files in single folder (shared) or files listed in single page of response (team)
  const {data} = await drive.files.list(options)

  const {files, nextPageToken} = data
  const combined = listSoFar.concat(files)

  // If there is more data the API has not returned for the query, the request needs to continue
  if (nextPageToken) {
    return fetchAllFiles({
      nextPageToken,
      listSoFar: combined,
      drive,
      parentIds,
      driveType
    })
  }

  // If there are no more pages and this is not a shared folder, return completed list
  if (driveType !== 'folder') return combined

  // Continue searching if shared folder, since API only returns contents of the immediate parent folder
  // Find folders that have not yet been searched
  const folders = combined.filter((item) =>
    item.mimeType === 'application/vnd.google-apps.folder' && parentIds.includes(item.parents[0]))

  if (folders.length > 0) {
    return fetchAllFiles({
      listSoFar: combined,
      drive,
      parentIds: folders.map((folder) => folder.id),
      driveType
    })
  }

  return combined
}

function produceTree(fileMap, parentDriveName = "") {
  const driveIds = Object.keys(fileMap)
  const files = driveIds.reduce(function (r, k) {
      return r.concat(fileMap[k]);
  }, [])
  // maybe group into folders first?
  // then build out tree, by traversing top down
  // keep in mind that files can have multiple parents
  const [byParent, byId, tagIds] = files.reduce(([byParent, byId, tagIds], resource) => {
    const {parents, id, name} = resource

    // prepare data for the individual file and store later for reference
    // FIXME: consider how to remove circular dependency here.
    const prettyName = docs.cleanName(name)
    const slug = docs.slugify(prettyName)
    const tagString = (name.match(/\|\s*([^|]+)$/i) || [])[1] || ''
    const tags = tagString.split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0)

    byId[id] = Object.assign({}, resource, {
      prettyName,
      tags,
      resourceType: cleanResourceType(resource.mimeType),
      sort: determineSort(name),
      slug,
      isTrashCan: slug === 'trash' && driveIds.filter((d) => parents.includes(d)).length > 0
    })

    // add the id of this item to a list of tags
    tags.forEach((t) => {
      const idsSoFar = tagIds[t] || []
      idsSoFar.push(id)
      tagIds[t] = idsSoFar
    })

    // for every parent, make sure the current file is in the list of children
    // this is used later to traverse the tree
    parents.forEach((parentId) => {
      const parent = byParent[parentId] || {children: [], home: null}
      const matchesHome = name.trim().match(/\bhome(?:,|$)/i)

      // need to do something here with tags
      // check if this is the first file for this parent with "home" at the end
      // if not it is a child, if so it is the index
      if (!matchesHome || parent.home) {
        parent.children.push(id)
      } else {
        parent.home = id
        byId[id].isHome = true
      }

      byParent[parentId] = parent
    })

    return [byParent, byId, tagIds]
  }, [{}, {}, {}])

  if (driveType == 'org') {
    const orgParent = {children: [], home: null}
    const orgResource = Object.assign({}, {}, {
      id: driveOrgName,
      name: driveOrgName,
      prettyName: driveOrgName,
      tags: [],
      resourceType: cleanResourceType('org'),
      sort: determineSort(),
      slug: driveOrgName,
      isTrashCan: false,
      parents: []
    })
    byId[driveOrgName] = orgResource

    Object.keys(byParent).forEach((p) => {
      if (orgDrives[p]) {
        const curDrive = orgDrives[p]
        orgParent.children.push(p)
        // add the drive to byId?
        const driveResource = Object.assign({}, {}, {
          id: p,
          name: curDrive.name,
          prettyName: curDrive.name,
          tags: [],
          resourceType: cleanResourceType('teamDrive'),
          sort: determineSort(),
          slug: docs.cleanName(docs.slugify(curDrive.name)),
          isTrashCan: false,
          parents: [driveOrgName]
        })
        byId[p] = driveResource
      }
    })
    byParent[driveOrgName] = orgParent
  }

  const oldInfo = docsInfo
  const oldBranches = driveBranches
  tags = tagIds
  docsInfo = addPaths(byId, driveIds) // update our outer cache w/ data including path information
  driveBranches = byParent
  return driveIds.map((d) => buildTreeFromData(d, {info: oldInfo, tree: oldBranches}))
}

// do we care about parent ids? maybe not?
function buildTreeFromData(rootParent, previousData, breadcrumb) {
  const {children, home} = driveBranches[rootParent] || {}
  const parentInfo = docsInfo[rootParent] || {}

  if (!breadcrumb) {
    log.debug("Parent info: " + rootParent)
  }
  breadcrumb = breadcrumb ? breadcrumb : [{ id: rootParent, slug: Object.values(orgDrives).filter((d) => d.id === rootParent).map((d) => docs.cleanName(docs.slugify(d.name))) }]

  const parentNode = {
    nodeType: children ? 'branch' : 'leaf',
    home,
    id: rootParent,
    breadcrumb,
    sort: parentInfo ? determineSort(parentInfo.name) : Infinity // some number here that could be used to sort later
  }

  // detect redirects or purge cache for items not contained in trash
  if (!parentInfo.isTrashCan) handleUpdates(rootParent, previousData)

  if (!children) {
    return parentNode
  }

  // we have to assemble these paths differently
  return children.reduce((memo, id) => {
    const {slug} = docsInfo[id]
    const nextCrumb = breadcrumb ? breadcrumb.concat({ id: rootParent, slug: parentInfo.slug }) : []

    // recurse building up breadcrumb
    memo.children[slug] = buildTreeFromData(id, previousData, nextCrumb)

    return memo
  }, Object.assign({}, parentNode, { children: {} }))
}

function addPaths(byId, driveIds) {
  return Object.values(byId)
    .reduce((memo, data) => {
      const parentData = derivePathInfo(data, byId)
      memo[data.id] = Object.assign({}, data, parentData)
      return memo
    }, {})

  function derivePathInfo(item) {
    const {parents, slug, webViewLink: drivePath, isHome, resourceType, tags} = item || {}
    const parentId = parents[0]
    const hasParent = parentId && !driveIds.includes(parentId)
    const parent = byId[parentId]
    const renderInLibrary = isSupported(resourceType) || tags.includes('playlist')

    if (hasParent && !parent) {
      log.warn(`Found file (${item.name}) with parent (${parentId}) but no parent info!`)
      return {}
    }

    // Clean up all this
    const teamDriveDefault = parentId || driveOrgName
    const rootDrive = (driveType == 'org' && !hasParent && teamDriveDefault != driveOrgName) ? '/' + docs.cleanName(docs.slugify(orgDrives[teamDriveDefault].name)) : ''
    const parentInfo = hasParent ? derivePathInfo(parent) : {path: rootDrive + '/', tags: []}
    const libraryPath = isHome ? parentInfo.path : path.join((parentInfo.path === undefined ? '/' + item.slug : parentInfo.path), slug)
    // the end of the path will be item.slug
    return {
      folder: Object.assign({}, parent, parentInfo), // make sure folder contains path
      topLevelFolder: hasParent ? parentInfo.folder : Object.assign({}, item),
      // FIXME: we should eventually support multiple paths that documents could live in
      path: renderInLibrary ? libraryPath : drivePath
    }
  }
}

async function retrievePlaylistData(id) {
  const authClient = await getAuth()
  const sheets = google.sheets({version: 'v4', auth: authClient})
  const response = await sheets.spreadsheets.values.get({spreadsheetId: id, range: 'A1:A100'})

  // format data from api response
  const playlistIds = response.data.values.slice(1).map((link) => {
    const id = url.parse(link[0]).pathname.split('/')[3]
    return id
  })

  playlistInfo[id] = playlistIds

  return playlistIds
}

function handleUpdates(id, {info: lastInfo, tree: lastTree}) {
  const currentNode = driveBranches[id] || {}
  const lastNode = lastTree[id] || {}
  const isFirstRun = !Object.keys(lastTree).length // oldTree is empty on the first check

  // combine current and previous children ids uniquely
  const allPages = (currentNode.children || [])
    .concat(currentNode.home || [])
    .concat(lastNode.children || [])
    .concat(lastNode.home || [])
    .filter((v, i, list) => list.indexOf(v) === i)

  // check all the nodes to see if they have changes
  allPages.forEach((id) => {
    // compare old item to new item
    const newItem = docsInfo[id]
    const oldItem = lastInfo[id]

    // since we have a "trash" folder we need to account
    // for both missing items and "trashed" items
    const isTrashed = (item) => !item || item.path.split('/')[1] === 'trash'
    if (!isFirstRun && (isTrashed(newItem) || isTrashed(oldItem))) {
      const item = isTrashed(oldItem) ? newItem : oldItem
      const {path, modifiedTime} = item
      const action = isTrashed(oldItem) ? 'Added' : 'Removed'
      // FIXME: This does not restore deleted documents which are undone to the same location
      return cache.purge({
        url: path,
        modified: modifiedTime,
        editEmail: `item${action}`,
        ignore: ['missing', 'modified']
      }).catch((err) => {
        log.debug('Error purging trashed item cache', err)
      })
    }

    // don't allow direct purges updates for folders with a home file
    const hasHome = newItem && (driveBranches[newItem.id] || {}).home
    if (hasHome) return

    // if this existed before and the path changed, issue redirects
    if (oldItem && newItem.path !== oldItem.path) {
      cache.redirect(oldItem.path, newItem.path, newItem.modifiedTime)
    } else {
      // should we be calling purge every time?
      // basically we are just calling purge because we don't know the last modified
      cache.purge({url: newItem.path, modified: newItem.modifiedTime}).catch((err) => {
        if (!err) return

        // Duplicate purge errors should be logged at debug level only
        if (err.message.includes('Same purge id as previous')) return log.debug(`Ignoring duplicate cache purge for ${newItem.path}`, err)

        // Ignore errors if not found or no fresh content, just allow the purge to stop
        if (err.message.includes('Not found') || err.message.includes('No purge of fresh content')) return

        // Log all other cache purge errors as warnings
        log.warn(`Cache purging error for ${newItem.path}`, err)
      })
    }
  })
}

function determineSort(name = '') {
  const sort = name.match(/(\d+)[^\d]/)
  // to be consistent with drive API, we will do string sort
  // also means we can sort off a single field when number is absent
  return sort ? sort[1] : name // items without sort go alphabetically
}

function cleanResourceType(mimeType) {
  const match = mimeType.match(/application\/vnd.google-apps.(.+)$/)
  if (!match) return mimeType

  return match[1]
}

async function startTreeRefresh(interval) {
  log.debug('updating tree...')

  try {
    await updateTree()
    log.debug('tree updated.')
  } catch (err) {
    log.warn('failed updating tree', err)
  }

  setTimeout(() => { startTreeRefresh(interval) }, interval)
}
