// Semantic normalization of an haproxy config, for proving a refactor is
// behavior-preserving without requiring byte-identical output. haproxy tokenizes each
// directive on whitespace and ignores blank lines and indentation, so two configs
// that normalize equal are identical to haproxy — even if one has been tidied of
// trailing/doubled spaces. Per line: trim + collapse internal whitespace to single
// spaces; drop blank lines; preserve line order and token content.
//
// Usage:  normalize(oldCfg) === normalize(newCfg)  // -> behaviorally identical
module.exports = (text) => text.split('\n')
  .map((line) => line.trim().replace(/\s+/g, ' '))
  .filter((line) => line !== '')
  .join('\n');
