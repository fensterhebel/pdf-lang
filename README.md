# pdf-lang
Parse, modify and serialize PDF files with Node

## idea & motivation
I was looking for a simple and small implementation of the PDF specs to manipulate PDFs on a basic level.
PDF.js is comparably heavy including the possibility to render files which is great for use with a browser.
Other libraries depend on command line tools (like qpdf, pdftk or mutool) written in another language.

## example usage
### show contents
```javascript
const { inspect } = require('pdf-lang')
PDF.inspect('file.pdf')
// lists all pdf objects by id:
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
*/
```
