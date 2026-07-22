// Semantic normalization of an haproxy config, for proving a refactor is
// behavior-preserving without requiring byte-identical output. haproxy tokenizes each
// directive on whitespace and ignores comments (# to end of line), blank lines and
// indentation, so two configs that normalize equal are identical to haproxy — even if
// one has been tidied of cruft or reworded comments. Per line: strip any `#` comment,
// trim, collapse internal whitespace to single spaces; then drop blank lines.
//
// Usage:  normalize(oldCfg) === normalize(newCfg)  // -> behaviorally identical
module.exports = (text) => text.split('\n')
  .map((line) => line.replace(/#.*$/, '').trim().replace(/\s+/g, ' '))
  .filter((line) => line !== '')
  .join('\n');
