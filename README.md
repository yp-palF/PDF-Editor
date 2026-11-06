# Lightweight PDF Editor

A small PDF editor that runs fully in your browser.
Your PDF is never uploaded. All reading, editing and saving happen on your computer.

## Run it

```bash
npm start
```

Then open http://localhost:8080. If that port is busy, use `PORT=8081 npm start`.

To put the site online for free and count users, see [DEPLOY.md](DEPLOY.md).

## What you can do

- **Edit text**: click any text in the PDF and type new text. It uses the PDF's own font, size and color.
- **Add text**: click anywhere on a page and type. You can also use the fonts found in the PDF.
- **Draw**, **Box**, **Highlight**, **White-out**, and **Image**.
- **Select**: move, resize (boxes and images), or delete what you added. Double-click text to edit it.
- **Pages** (in the left panel): move up and down, rotate, add a blank page, delete.
- **Add PDF**: add another PDF to the end.
- **Undo / Redo** and **Download**.

Keyboard: `V` select, `E` edit text, `T` add text, `P` draw, `R` box, `H` highlight, `W` white-out,
`Ctrl/Cmd + Z` undo, `Ctrl/Cmd + Shift + Z` redo, `Delete` remove the selected item.

## How font matching works

1. When you click on text, the editor finds the font that text uses.
2. If the font file is inside the PDF, it is reused for your new text, on screen and in the saved file.
   The font bar shows "Original font: …".
3. PDFs often keep only the letters they need. If you type a letter the font does not have,
   the editor uses the closest standard font (Helvetica, Times or Courier, with bold and italic)
   and tells you which letter was missing.
4. If the font is not inside the PDF (for example plain "Times-Roman"), the matching standard font is used.

## How privacy is kept

- The libraries ([pdf.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/), fontkit) are stored in `vendor/`. Nothing loads from a CDN.
- `index.html` has a Content Security Policy. The page can only load its own files and cannot send data to any other server.
- `server.js` only serves the app files. It never receives your PDF.

## Known limits

- **Edit text** hides the old text under a box with the background color and writes the new text on top.
  The old text is still inside the file (it can be copied or searched). So do not use it, or White-out, to hide private data.
- Standard fonts only support basic Latin letters. Other letters are saved as `?`.

## Files

- `index.html`, `styles.css`, `icons.js`: the page and its look.
- `app.js`: all the editor logic.
- `vendor/`: local copies of the libraries. Rebuild with `npm install && npm run vendor`.
- `samples/`: small PDFs for testing (`fonts-sample.pdf` has embedded fonts).
- `DEPLOY.md`: how to publish the site and count users.
