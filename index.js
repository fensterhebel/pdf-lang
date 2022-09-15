const fs = require('fs')
const util = require('util')
const zlib = require('zlib')

const localDate = (date = null) => {
  if (!date) {
    date = new Date()
  }
  const offset = date.getTimezoneOffset()
  date = 'D:' + new Date(date.getTime() - offset * 6e4).toJSON().substr(0, 19).replace(/\D/g, '')
  date += (offset > 0 ? '-' : '+') + [Math.floor(Math.abs(offset / 60)), Math.abs(offset) % 60].map(n => n.toString().padStart(2, '0')).join('\'')
  return date
}
const rgb2cmyk = (...rgb) => {
  const l = Math.max(...rgb)
  const cmyk = rgb.map(v => !l ? 0 : (l - v) / l)
  cmyk.push(1 - l)
  return cmyk
}
const mm2pt = mm => mm * 72 / 25.4

const DEFAULT_VERSION = 'PDF-1.4'
const DEFAULT_PAPERSIZE = [0, 0, mm2pt(210), mm2pt(297)] // A4

class obj {
  constructor (id, gen = 0) {
    this.id = id
    // this.gen = gen
  }
}
class Objects {
  constructor (size = 0) {
    this.objects = new Array(size)
    this.refs = new Array(size)
  }

  get length () {
    return this.objects.length - this.objects.slice().reverse().findIndex(o => !!o)
  }

  ref (id) {
    if (typeof this.refs[id - 1] === 'undefined') {
      this.refs[id - 1] = new obj(id)
    }
    return this.refs[id - 1]
  }

  get (id, original = false) {
    let o = this.objects[id - 1]
    if (typeof o === 'function') {
      o = o()
      if (typeof o === 'undefined') {
        o = this.objects[id - 1]
      } else {
        this.set(id, o)
      }
    }
    return (original && o[Symbol.for('original')]) || o || null
  }

  set (id, value) {
    this.objects[id - 1] = value
    return value
  }

  add (value, atEnd = false) {
    let id = 1 + this.objects.findIndex(o => typeof o === 'undefined')
    if (atEnd || !id) {
      id = 1 + this.objects.length
    }
    this.set(id, value)
    return this.ref(id)
  }

  remove (id) {
    delete this.objects[id - 1]
    this.refs[id - 1].id = 0
    delete this.refs[id - 1]
  }

  original (o) {
    return o[Symbol.for('original')] || o
  }

  proxy (o) {
    if (typeof o !== 'object') {
      return o
    }
    // const objects = this.objects
    const self = this
    return new Proxy(o, {
      get (target, prop) {
        if (prop === Symbol.for('original')) {
          return target
        }
        if (target[prop] instanceof obj) {
          // return objects[target[prop].id - 1]
          return self.get(target[prop].id)
        }
        return target[prop]
      },
      set (target, prop, value) {
        // if (prop === Symbol.for('original')) {
          // target = value
          // return true
        // }
        if (target[prop] instanceof obj) {
          self.set(target[prop].id, value)
          return true
        }
        target[prop] = value
        return true
      }
    })
  }

  static decode (obj) {
    const filter = obj.Filter && Symbol.keyFor(obj.Filter)
    if (!filter) {
      return obj[Symbol.for('stream')]
    } else if (filter === 'FlateDecode') {
      return zlib.inflateSync(obj[Symbol.for('stream')])
    }
    throw new Error('Filter "' + filter + '" unknown')
  }
}

class PDFParser {
  constructor (buffer) {
    this.objects = null
    this.raw = buffer
    this.pos = 0
  }

  parse () {
    this.version = this.readRegExp(/^%PDF-[^\r\n]+/).substr(1)
    // Read XRef
    this.pos = this.raw.lastIndexOf('startxref')
    this.skip('startxref')
    this.pos = this.readNumber()
    this.skipWhitespace()
    if (this.test('xref')) {
      this.skip('xref')
      const start = this.readNumber()
      const size = this.readNumber()
      this.objects = new Objects(size)
      for (let id = start; id < size; id++) {
        const pos = this.readNumber()
        const gen = this.readNumber()
        if ('n' === this.readRegExp(/^\s*[fn]/).trim()) {
          this.objects.set(id, () => this.readObject(pos))
        }
      }
      // Read Trailer
      this.pos = this.raw.lastIndexOf('trailer')
      this.skip('trailer')
      const trailer = this.readDictionary()
      return trailer
    }

    // Read XRef-Object (Dictionary in stream)
    this.objects = new Objects()
    const xref = this.readObject(this.pos)
    if (xref.Type.toString().slice(7, -1) !== 'XRef') {
      throw new Error('expected XRef dictionary')
    }
    const data = Objects.decode(xref)
    const w = xref.W.reduce((a, c) => a + c, 0)
    for (let id = 0; id * w < data.length; id++) {
      const flag = data[id * w]
      const pos = data.readUIntBE(id * w + xref.W[0], xref.W[1])
      const gen = data.readUIntBE(id * w + xref.W[0] + xref.W[1], xref.W[2])
      // console.log(id, flag, pos, gen)
      if (flag === 1) {
        this.objects.set(id, () => {
          console.log(id)
          return this.readObject(pos)
        })
      } else if (flag === 2) {
        this.objects.set(id, () => this.parseObjStm(this.objects.get(pos)))
      }
    }
    return xref
  }

  parseObjStm (obj) {
    if (Symbol.keyFor(obj.Type) !== 'ObjStm') {
      throw new Error('object not of type ObjStm')
    }
    const data = Objects.decode(obj)
    const state = {
      pos: this.pos,
      raw: this.raw
    }
    this.raw = data
    this.pos = 0
    for (let i = 0; i < obj.N; i++) {
      const id = this.readNumber()
      const offset = this.readNumber()
      const pos = this.pos
      this.pos = obj.First + offset
      const o = this.readAnything()
      this.objects.set(id, o)
      this.pos = pos
    }
    Object.assign(this, state)
  }

  test (str) {
    const pos = this.pos
    this.skipWhitespace()
    const next = this.raw.slice(this.pos, this.pos + str.length).toString()
    this.pos = pos
    return next === str
  }

  skip (str) {
    this.skipWhitespace()
    if (!this.test(str)) {
      const next = this.raw.slice(this.pos, this.pos + str.length).toString()
      throw new Error('expected "' + str + '" but found "' + next + '" @' + this.pos)
    }
    this.pos += str.length
  }

  readRegExp (chars) {
    let match = null
    for (let i = 1; !match && i <= 8; i *= 2) {
      match = this.raw.slice(this.pos, this.pos + 16 * i).toString().match(chars)
      if (match && match[0].length === 16 * i) {
        // we can't be sure, that the match wouldn't be longer if the slice was longer
        match = null
      }
    }
    if (!match) {
      throw new Error('RegExp ' + chars.toString() + ' could not be found @' + this.pos)
    }
    if (match.index) {
      console.error('[WARN] RegExp ' + chars.toString() + ' was found @' + this.pos + ' with a gap of +' + match.index)
    }
    this.pos += match.index + match[0].length
    return match[0]
  }

  skipWhitespace (skipComments = true) {
    this.readRegExp(skipComments ? /^([\u0000\t\n\f\r ]*(%[^\n\r]*)?)+/ : /^[\u0000\t\n\f\r ]*/)
    // do {
      // if (skipComments && this.raw[this.pos] === 0x25) {
        // // this.skipChars([0x0a, 0x0d], true)
        // this.readRegExp(/^[^\n\r]+/)
      // }
    // } while (this.skipChars([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) && skipComments)

    // while (this.pos < this.raw.length && [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(this.raw[this.pos])) {
      // this.pos++
      // // also skip comments
      // if (this.raw[this.pos] === 0x25) {
        // this.pos = this.findEOL()
      // }
    // }
  }

  readNull () {
    this.skip('null')
    return null
  }

  readBoolean () {
    this.skipWhitespace()
    if (this.raw[this.pos] === 0x74) {
      this.skip('true')
      return true
    }
    this.skip('false')
    return false
  }

  readNumber () {
    this.skipWhitespace()
    const next = this.readRegExp(/^[+-]?\d*(\.\d+)?/)
    return +next
  }

  readString () {
    this.skipWhitespace()
    if (this.raw[this.pos] === 0x3c) {
      const t = this.raw.indexOf('>', this.pos)
      const buf = this.raw.slice(this.pos + 1, t).toString() + '0'
      this.pos = t + 1
      return Buffer.from(buf, 'hex').toString()
    }
    if (this.raw[this.pos] !== 0x28) {
      throw new Error('no string at ' + this.pos)
    }
    let p = this.pos
    let unmatched = 0
    do {
      if (this.raw[p - 1] !== 0x5c) {
        if (this.raw[p] === 0x28) {
          unmatched++
        } else if (this.raw[p] === 0x29) {
          unmatched--
        }
      }
      p++
    } while (unmatched)
    const str = this.raw.slice(this.pos + 1, p - 1).toString()
    this.pos = p
    return str
      .replace(/\\(\n|\r\n?)/g, '\n')
      .replace(/\\[\\bfnrt]/g, m => JSON.parse('"' + m + '"'))
      .replace(/\\([()])/g, '$1')
      .replace(/\\(\d{1,3})/g, (m, n) => String.fromCharCode(parseInt(n, 8)))
  }

  readName () {
    this.skip('/')
    const next = this.readRegExp(/^[^\u0000\t\n\f\r /\[\]()<>]+/)
    const name = next.replace(/#([0-9a-fA-F]{2})/g, (m, n) => String.fromCharCode(parseInt(n, 16)))
    return Symbol.for(name)
  }

  readArray () {
    const a = []
    this.skip('[')
    this.skipWhitespace()
    while (this.raw.indexOf(']', this.pos) > this.pos) {
      a.push(this.readAnything())
      this.skipWhitespace()
    }
    this.skip(']')
    return this.objects.proxy(a)
  }

  readDictionary () {
    const o = {}
    this.skip('<<')
    this.skipWhitespace()
    while (this.raw.indexOf('>>', this.pos) > this.pos) {
      const key = Symbol.keyFor(this.readName()) // .toString().slice(7, -1)
      const value = this.readAnything()
      o[key] = value
      this.skipWhitespace()
    }
    this.skip('>>')
    return this.objects.proxy(o)
  }

  readAnything () {
    this.skipWhitespace()
    const next = this.raw.slice(this.pos, this.pos + 5).toString()
    if (next.startsWith('/')) {
      return this.readName()
    } else if (next.startsWith('<<')) {
      return this.readDictionary()
    } else if (next.startsWith('[')) {
      return this.readArray()
    } else if (next.startsWith('true') || next.startsWith('false')) {
      return this.readBoolean()
    } else if (next.startsWith('null')) {
      return this.readNull()
    } else if (next.startsWith('(') || next.startsWith('<')) {
      return this.readString()
    }
    const number = this.readNumber()
    const pos = this.pos
    this.skipWhitespace()
    if (this.raw[this.pos] >= 0x30 && this.raw[this.pos] < 0x40) {
      try {
        const gen = this.readNumber()
        this.skip('R')
        return this.objects.ref(number)
      } catch (e) {
      }
    }
    this.pos = pos
    return number
  }

  readObject (pos) {
    this.pos = pos
    const id = this.readNumber()
    const gen = this.readNumber()
    this.skip('obj')
    const o = this.readAnything()
    if (this.test('stream')) {
      if (!(typeof o === 'object' && 'Length' in o)) {
        throw new Error('stream of unknown length')
      }
      this.skip('stream')
      this.readRegExp(/^\r?\n/)
      const start = this.pos
      const end = this.pos + o.Length
      o[Symbol.for('stream')] = this.raw.slice(start, end)
      this.pos = end
      this.skip('endstream')
      // // immediately decode ObjStm
      // if (Symbol.keyFor(o.Type) === 'ObjStm') {
        // this.parseObjStm(o)
      // }
    }
    this.skip('endobj')
    return o
  }
}

class PDFSerializer {
  constructor (tree, objects, version = DEFAULT_VERSION) {
    Object.assign(this, { tree, objects, version })
    this.pos = 0
  }

  toFile (target) {
    this.file = target
    fs.writeFileSync(this.file, '%' + this.version + '\n')
    this.pos = 2 + this.version.length
    this.write(Buffer.from('25b5edaefb0a', 'hex'))
    this.written = new Array(this.tree.Size || 0)
    // for (let i = 0; i < this.objects.length; i++) {
      // if (!this.objects[i] || typeof this.objects[i] !== 'object') {
        // this.objects.splice(i, 1)
        // i--
        // continue
      // }
      // this.objects[i].__id = 1 + i
      // delete this.objects[i].__written
    // }
    this.tree.Size = 1 + this.objects.length
    const trailer = 'trailer\n' + this.serialize(this.tree) + '\n'
    // const trailer = 'trailer\n' + this.serialize(this.objects.get(2)) + '\n'
    let xref = 'xref\n0 ' + this.tree.Size + '\n'
    for (let id = 0; id < this.tree.Size; id++) {
      if (this.written[id - 1]) {
        xref += this.written[id - 1].toString().padStart(10, '0') + ' 00000 n \n'
      } else {
        xref += '0000000000 ' + (id ? '00000' : '65535') + ' f \n'
      }
    }
    this.write(xref + trailer + 'startxref\n' + this.pos + '\n%%EOF')
    return target
  }

  write (buffer) {
    fs.appendFileSync(this.file, buffer)
    this.pos += buffer.length
  }

  writeObject (id) {
    if (this.written[id - 1]) {
      return
    }
    this.written[id - 1] = true // to prevent endless recursion
    const o = this.objects.get(id)
    let data = id + ' 0 obj\n'
    data += this.serialize(o) + '\n'
    this.written[id - 1] = this.pos
    if (o[Symbol.for('stream')]) {
      data += 'stream\n'
      this.write(data)
      this.write(o[Symbol.for('stream')])
      data = '\n'
      data += 'endstream\n'
    }
    data += 'endobj\n'
    this.write(data)
  }

  serialize (o) {
    if (typeof o === 'object') {
      o = this.objects.original(o)
    }
    if (o instanceof Number) {
      return o.toString()
    } else if (o instanceof obj) {
      this.writeObject(o.id)
      return o.id + ' 0 R'
    } else if (Array.isArray(o)) {
      return '[' + o.map(c => this.serialize(c)).join(' ') + ']'
    } else if (typeof o === 'object' && !(o instanceof String)) {
      let data = '<< '
      for (const key in o) {
        data += '/' + key + ' '
        data += this.serialize(o[key])
        data += ' '
      }
      data += '>>'
      return data
    } else if (typeof o === 'symbol') {
      return '/' + o.toString().slice(7, -1)
    } else if (typeof o === 'string') {
      // TODO: Unicode-Probleme oder so?
      return !o.length ? '<>' : '(' + o + ')'
    }
    return o.toString()
  }
}

class PDF {
  constructor (file = null) {
    if (!file || typeof file === 'object') {
      Object.assign(this, { version: DEFAULT_VERSION }, file)
      this.objects = new Objects()
      this.tree = this.objects.proxy({
        Info: this.createObject({
          Creator: 'pdf-lang'
        }),
        Root: this.createObject({
          Type: Symbol.for('Catalog'),
          Pages: this.createObject({
            Type: Symbol.for('Pages'),
            Kids: [],
            Count: 0
          })
        })
      })
    } else {
      this.raw = fs.readFileSync(file)
      const parser = new PDFParser(this.raw)
      this.tree = parser.parse()
      this.version = parser.version
      this.objects = parser.objects
    }
  }

  static inspect (file) {
    const pdf = new this(file)
    for (let i = 1; i <= pdf.objects.length; i++) {
      console.log(i, util.inspect(pdf.getObject(i), { depth: 4, colors: true }))
    }
  }

  toFile (target) {
    // this.tree.Info.Producer = 'pdf-lang'
    // this.tree.Info.ModDate = localDate()
    const serializer = new PDFSerializer(this.tree, this.objects, this.version)
    return serializer.toFile(target)
  }

  getOriginal (o) {
    return this.objects.original(o)
  }

  getObject (id, original = false) {
    return this.objects.get(id, original)
  }

  createObject (o) {
    return this.objects.add(this.objects.proxy(o))
  }

  deleteObject (id) {
    this.objects.splice(id - 1, 1)
  }

  getStream (id, raw = false) {
    const o = typeof id === 'number' ? this.objects.get(id) : id
    return raw ? o[Symbol.for('stream')] : Objects.decode(o)
  }

  createStream (data, dictionary = {}, id = 0) {
    const source = id ? this.objects.get(id) : null
    const filter = dictionary.Filter || source && source.Filter
    if (filter) {
      if (filter === Symbol.for('FlateDecode')) {
        data = zlib.deflateSync(data)
      }
    }
    if (id) {
      Object.assign(source, {
        Length: data.length,
        [Symbol.for('stream')]: data
      }, dictionary)
      return this.objects.ref(id)
    }
    return this.createObject(Object.assign({
      Length: data.length,
      [Symbol.for('stream')]: data
    }, dictionary))
  }

  *getPages (original = false) {
    const stack = [{
      kids: this.tree.Root.Pages.Kids,
      i: 0
    }]
    let current
    while (stack.length) {
      current = stack[stack.length - 1]
      if (current.i < current.kids.length) {
        if (Symbol.keyFor(current.kids[current.i].Type) === 'Pages') {
          stack.push({
            kids: current.kids[current.i].Kids,
            i: 0
          })
        } else {
          yield (original ? this.getOriginal(current.kids[current.i]) : current.kids[current.i])
        }
        current.i++
      } else {
        stack.pop()
      }
    }
  }

  getPage (index = 0) {
    const pages = this.getPages()
    for (let i = 0; i < index; i++) {
      pages.next()
    }
    return pages.next().value
  }

  deletePage (page) {
    // page = typeof page === 'number' ? this.getPages()[page]
    const index = page.Parent.Kids.findIndex(p => p === page)
    const id = this.getOriginal(page.Parent.Kids)[index].id
    this.getOriginal(page.Parent.Kids).splice(index, 1)[0]
    let parent = page.Parent
    while (parent) {
      parent.Count--
      parent = parent.Parent
    }
    this.objects.remove(id)
  }

  addPage (page) {
    page = this.getOriginal(page || {})
    page = this.createObject(Object.assign({
      Type: Symbol.for('Page'),
      Parent: this.getOriginal(this.tree.Root).Pages,
      // Resources: this.Resources,
      MediaBox: DEFAULT_PAPERSIZE.slice(0)
    }, page))
    this.tree.Root.Pages.Kids.push(page)
    this.tree.Root.Pages.Count++
    return page
  }

  toCMYK (func = null) {
    const done = []
    for (const page of this.getPages()) {
      // const id = this.getOriginal(page.Parent.Kids)[page.Parent.Kids.findIndex(p => p === page)].id
      const id = this.getOriginal(page).Contents.id
      if (done.includes(id)) {
        continue
      }
      done.push(id)
      let contents = this.getStream(id).toString()
      contents = contents.replace(/([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+(rg)/gi, (_, r, g, b, f) => {
        const rgb = [+r, +g, +b]
        let cmyk = rgb2cmyk(...rgb)
        if (typeof func === 'function') {
          cmyk = func(rgb, cmyk)
        }
        return cmyk.map(n => n.toFixed(5)).join(' ') + ' ' + (f.toLowerCase() === f ? 'k' : 'K')
      })
      this.createStream(contents, {}, id)
      // page.Group = {
        // Type: Symbol.for('Group'),
        // S: Symbol.for('Transparency'),
        // CS: Symbol.for('DeviceCMYK')
      // }
    }
    return this
  }

  trim (pt = 0) {
    for (const page of this.getPages()) {
      page.MediaBox = page.MediaBox.map((v, i) => i < 2 ? v + pt : v - pt)
    }
    return this
  }

  cut (y = 1, x = 1) {
    if (x * y <= 1) return
    const pages = [...this.getPages()]
    for (const page of pages) {
      const kids = this.getOriginal(page.Parent.Kids)
      const box = page.MediaBox
      this.deletePage(page)
      for (let j = y - 1; j >= 0; j--) {
        for (let i = 0; i < x; i++) {
          kids.push(this.createObject(Object.assign({}, this.getOriginal(page), {
            MediaBox: [
              box[0] + (box[2] - box[0]) / x * i,
              box[1] + (box[3] - box[1]) / y * j,
              box[0] + (box[2] - box[0]) / x * (i + 1),
              box[1] + (box[3] - box[1]) / y * (j + 1)
            ]
          })))
          page.Parent.Count++
        }
      }
    }
    return this
  }
}

module.exports = {
  PDF, PDFParser, PDFSerializer,
  localDate, rgb2cmyk, mm2pt
}
