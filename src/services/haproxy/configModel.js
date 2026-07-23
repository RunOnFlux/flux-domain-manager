// The line/section/config classes form one cohesive AST — kept in a single module.
/* eslint-disable max-classes-per-file */
// A generic, hierarchical model of an HAProxy configuration and its serializer.
//
// Structure: HaproxyConfig -> Section -> (Directive | Comment | Blank) lines. A
// Directive is just a keyword plus ordered argument tokens, so ANY haproxy directive
// is representable without a bespoke type — the model never needs a schema update to
// carry a new keyword or section kind. Sections and lines keep their insertion order,
// so order-sensitive constructs (interleaved `acl` / `use_backend`, server ordering)
// render exactly as built.
//
// Serialization is deterministic and clean: section headers at column 0, bodies
// indented two spaces, single spaces between tokens, one blank line between sections,
// no trailing whitespace. Empty argument tokens (null / undefined / '') are dropped,
// so a conditional clause that resolves to '' simply disappears rather than leaving a
// trailing or doubled space — this is what lets the builders emit tidy output while a
// hand-written concat would have left the cruft in.

const INDENT = '  ';

// One config line: `keyword arg1 arg2 ...`. Args may be multi-token strings; empties
// are dropped so absent optional clauses leave no whitespace behind.
class Directive {
  constructor(keyword, args = []) {
    this.keyword = keyword;
    this.args = args.filter((a) => a !== null && a !== undefined && a !== '');
  }

  render(indent) {
    const tokens = this.keyword === '' ? this.args : [this.keyword, ...this.args];
    return `${indent}${tokens.join(' ')}`;
  }
}

class Comment {
  constructor(text) { this.text = text; }

  render(indent) { return `${indent}# ${this.text}`; }
}

class Blank {
  // eslint-disable-next-line class-methods-use-this
  render() { return ''; }
}

// A named or bare section (`frontend www`, `global`) holding an ordered list of lines.
class Section {
  constructor(type, name = null) {
    this.type = type;
    this.name = name;
    this.lines = [];
  }

  // Append a directive; returns this for chaining. Args with '' / null / undefined
  // are dropped by Directive, so optional clauses can be passed unconditionally.
  add(keyword, ...args) {
    this.lines.push(new Directive(keyword, args));
    return this;
  }

  // Append a pre-built line (Directive/Comment/Blank) — e.g. a directive assembled by
  // a helper. Returns this for chaining.
  push(line) {
    this.lines.push(line);
    return this;
  }

  // Append an already-formatted directive line verbatim (rendered with the body
  // indent). For lines a resolver hands back pre-joined.
  raw(text) {
    this.lines.push(new Directive(text, []));
    return this;
  }

  // Append a block of pre-written config text as verbatim lines — each non-blank line
  // becomes a raw directive (re-indented to the body). For folding an existing static
  // template (a fixed frontend/global body) into the model without re-tokenizing it.
  rawBlock(text) {
    text.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed !== '') this.raw(trimmed);
    });
    return this;
  }

  comment(text) {
    this.lines.push(new Comment(text));
    return this;
  }

  blank() {
    this.lines.push(new Blank());
    return this;
  }

  render() {
    const header = this.name ? `${this.type} ${this.name}` : this.type;
    return [header, ...this.lines.map((line) => line.render(INDENT))].join('\n');
  }
}

// The whole config: an ordered list of sections, rendered with a blank line between
// them and a trailing newline.
class HaproxyConfig {
  constructor() { this.sections = []; }

  section(type, name = null) {
    const section = new Section(type, name);
    this.sections.push(section);
    return section;
  }

  render() {
    return `${this.sections.map((section) => section.render()).join('\n\n')}\n`;
  }
}

// Section keywords that start a new section at column 0.

module.exports = {
  HaproxyConfig, Section, Directive, Comment, Blank,
};
