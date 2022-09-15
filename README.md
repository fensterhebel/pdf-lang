# pdf-lang
Parse, modify and serialize PDF files with Node

## idea & motivation
I was looking for a simple and small implementation of the PDF specs to manipulate PDFs on a basic level.
PDF.js is comparably heavy including the possibility to render files which is great for use with a browser.
Other libraries depend on command line tools (like qpdf, pdftk or mutool) written in another language.

## example usage
### list all pdf objects ordered by id
```javascript
const { PDF } = require('pdf-lang')
PDF.inspect('file.pdf')
/*
1 {
  Type: Symbol(Catalog),
  Pages: obj { id: 3 },
  PageLayout: Symbol(SinglePage),
  ViewerPreferences: { PageDirection: Symbol(L2R) }
}
2 {
  Creator: 'Scribus 1.5.5',
  Producer: 'Scribus PDF Library 1.5.5',
  Title: 'PDF-File',
  CreationDate: 'D:20220914071523Z'
}
3 {
  Type: Symbol(Pages),
  Kids: [
    obj { id: 4 },
  ],
  Count: 1
}
4 {
  Type: Symbol(Page),
  Parent: obj { id: 3 },
  MediaBox: [ 0, 0, 612.28346, 858.89764 ],
  TrimBox: [ 8.50394, 8.50394, 603.77953, 850.3937 ],
  Rotate: 0,
  Contents: obj { id: 5 }
}
5 {
  Length: obj { id: 6 },
  Filter: Symbol(FlateDecode),
  [Symbol(stream)]: <Buffer 78 da 6d 8e b1 0e 82 40 0c 86 ... 129 more bytes>
}
6 139
...
*/
```

### trim all pages by certain amount
```javascript
const { PDF, mm2pt } = require('pdf-lang')
const pdf = new PDF('file.pdf')
pdf.trim(mm2pt(3)) // trim each page by 3mm
pdf.toFile('file-trimmed.pdf')
```

### cut pages
```javascript
const { PDF } = require('pdf-lang')
const pdf = new PDF('file.pdf')
pdf.cut(2) // cut horizontally into 2
// OR
pdf.cut(1, 2) // cut vertically into 2
// OR 
pdf.cut(2, 2) // cut horizontally into 2 and then vertically into 2 (resulting in 4 pages)
pdf.toFile('file-cut.pdf')
```

### replace RGB colors with CMYK
naive implementation without profiles etc.
```javascript
const { PDF } = require('pdf-lang')
const pdf = new PDF('file.pdf')
pdf.toCMYK() // replacing all RGB values inside all content streams by respective CMYK values
// OR using a callback
pdf.toCMYK((rgb, cmyk) => {
  // simply returning cmyk would do the same as above
  // rgb is an Array(3) with values 0...1 (may seem odd, but that is how it is represented in pdf content streams)
  // cmyk is an Array(4) with values 0...1

  // you could implement your own lookup mechanism here
  rgb = rgb.map(v => Math.round(v * 255))
  ...
  cmyk = [ ... ]

// or do simple modifications like
  cmyk[1] *= 0.8
  return cmyk
})
pdf.toFile('file-cmyk.pdf')
```

### traverse through the internal tree structure
The base is `<PDF>.tree` which contains the PDF trailer. The nodes are `Proxy` objects, allowing the internal references to other objects (`obj { id: 2 }`) to be resolved.
```javascript
const { PDF } = require('pdf-lang')
const pdf = new PDF('file.pdf')
pdf.tree.Info.Producer = 'my amazing PDF-tool'
console.log(pdf.tree.Root.Pages)
/*
{
  Type: Symbol(Pages),
  Kids: [ obj { id: 8 },  obj { id: 12 } ],
  Count: 12,
  Resources: obj { id: 53 }
}
*/
console.log(pdf.tree.Root.Pages.Kids[0])
/*
{
  Type: Symbol(Page),
  Parent: obj { id: 3 },
  MediaBox: [ 0, 0, 612.28346, 858.89764 ],
  TrimBox: [ 8.50394, 8.50394, 603.77953, 850.3937 ],
  Rotate: 0,
  Contents: obj { id: 7 }
}
*/

// To retrieve an object’s id you need to "bypass" the proxy by getting the "original" object. (This works for Arrays `[]` and Objects `{}`)
const pageId = pdf.getOriginal(pdf.tree.Root.Pages.Kids)[0].id
const streamId = pdf.getOriginal(pdf.tree.Root.Pages.Kids[0]).Contents.id
// OR
const pageId = pdf.tree.Root.Pages.Kids[Symbol.for('original')][0].id
const streamId = pdf.tree.Root.Pages.Kids[0][Symbol.for('original')].Contents.id

// To get all page objects:
for (const page of pdf.getPages()) {
  ...
}
// or the first (or "n - 1"th page)
pdf.getPage(0) // first page
pdf.getPage(3) // fourth page
```

### get/modify stream contents
Example: move all text up a bit on the first page (not very reliable but 
```javascript
const { PDF } = require('pdf-lang')
const pdf = new PDF('file.pdf')
const streamId = pdf.tree.Root.Pages.Kids[0][Symbol.for('original')].Contents.id
let contents = pdf.getStream(streamId).toString() // decodes the stream if it is Flate encoded
contents = contents.replace(/-?[0-9.]+\s+-?[0-9.]+(?=\s+Tm)/g, (m) => {
  m = m.split(/\s+/).map(n => +n)
  m[1] += 3
  return m.join(' ')
})

// leave the Filter as it is (e.g. FlateDecode or None)
// and replace existing stream object by providing the old id
pdf.createStream(contents, {}, streamId)
// OR
// enforce deflating data
pdf.createStream(contents, { Filter: Symbol.for('FlateDecode') }, streamId)

pdf.toFile('file-modified.pdf')
```
