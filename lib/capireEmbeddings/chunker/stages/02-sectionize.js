function isEmptyLoner(node, siblings) {
  if (node.body.trim().length > 0) return false
  if (node.children.length > 0) return false
  const idx = siblings.indexOf(node)
  const isLoner = !siblings
    .slice(idx + 1)
    .some((s) => s.depth === node.depth && s.body.trim().length > 0)
  return isLoner
}

export function sectionize(nodes, config) {
  const sections = []
  let droppedSections = 0
  const maxDepth = config.maxHeadingDepth ?? Infinity

  const walk = (node, parentPath, targetSection, siblings) => {
    if (targetSection && node.depth > maxDepth) {
      // dont push empty children in parent body
      if (isEmptyLoner(node, siblings)) {
        droppedSections++
        return
      }
      const headingLine = node.raw
      const contribution = node.body.trim() ? headingLine + '\n\n' + node.body : headingLine
      targetSection.body += (targetSection.body ? '\n\n' : '') + contribution
      for (const child of node.children) walk(child, parentPath, targetSection, node.children)
      return
    }

    const headingPath = node.title === '' ? parentPath : [...parentPath, node.title]

    const section = {
      headingPath,
      heading: node.raw,
      source: node.source,
      depth: node.depth,
      body: node.body
    }
    sections.push(section)

    for (const child of node.children) {
      walk(child, headingPath, section, node.children)
    }
  }

  for (const node of nodes) {
    walk(node, [], null, nodes)
  }

  if (droppedSections)
    console.log(`[section] dropped ${droppedSections} empty sections during sectionize`)

  return sections
}
