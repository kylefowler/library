'use strict'

const search = require('../search')
const move = require('../move')
const log = require('../logger')

const router = require('express-promise-router')()

const {getAllTrees, hasDrive, getTreeForDriveSlug, getMeta, getTagged} = require('../list')
const {getTemplates, sortDocs, stringTemplate} = require('../utils')

router.get('/', handlePage)
router.get('/:page', handlePage)

module.exports = router

const pages = getTemplates('pages')

const driveType = process.env.DRIVE_TYPE

// express-promsie-router will call next() if the return value is 'next'.
async function handlePage(req, res) {
  var page = req.params.page || 'index'

  // If we are at the root of a team drive, show the categories for that team
  if (hasDrive(req.params.page)) {
    page = 'team'
  }

  if (!pages.has(page) && page !== 'team') return 'next'

  const template = `pages/${page}`
  const {q, id, dest} = req.query
  if (page === 'search' && q) {
    return search.run(q, driveType).then((results) => {
      res.render(template, {q, results, template: stringTemplate})
    })
  }

  if (page === 'move-file' && id) {
    if (!dest) {
      const folders = await move.getFolders(id)
      const {prettyName, parents} = getMeta(id)
      return res.render(template, {prettyName, folders, id, parents, template: stringTemplate})
    }

    return move.moveFile(id, dest, driveType).then((result) => {
      res.redirect(result)
    })
  }

  if (page === 'categories' || page === 'index') {
    const tree = await getAllTrees()
    const categories = buildDisplayCategories(tree)
    res.render(template, {...categories, template: stringTemplate})
    return
  } else if (page === 'team') {
    // Find the tree for the given team and show it
    const tree = await getTreeForDriveSlug(req.params.page)
    const categories = buildDisplayCategories([tree])
    res.render(template, {...categories, template: stringTemplate})
    return
  }

  res.render(template, {template: stringTemplate})
}

function buildDisplayCategories(tree) {
  const categories = tree.reduce((categories, item) => {
    const t = Object.keys(item.children).map((key) => {
      const data = item.children[key]
      data.path = `/${key}` // for now
      return data
    })
    return categories.concat(t)
  }, [])

  // Ignore pages at the root of the site on the category page
  const all = categories
    .map((c) => Object.assign({}, c, getMeta(c.id)))
    .filter(({resourceType, tags, isTrashCan}) => resourceType === 'folder' && !tags.includes('hidden') && !isTrashCan)
    .sort(sortDocs)
    .map((category) => {
      category.children = Object.values(category.children || {}).map(({id}) => {
        const {prettyName: name, path: url, resourceType, sort, tags} = getMeta(id)
        return { name, resourceType, url, sort, tags }
      })
      .filter(({ tags }) => !tags.includes('hidden'))
      .sort(sortDocs)
      return category
    })

  const teams = getTagged('team')
    .map(getMeta)
    .sort(sortDocs)

  const featured = getTagged('featured')
    .map(getMeta)
    .sort(sortDocs)

  return {all, teams, featured}
}
