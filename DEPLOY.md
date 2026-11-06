# Making the PDF Editor public

This guide has two parts:

1. **Put the site online** for free.
2. **Count your users** for free, without breaking the privacy promise.

The site is only static files (HTML, CSS, JavaScript). There is no server code and no database.
So any free static host works.

> Tip: use a personal GitHub account for a personal project, not a work account.

---

## Part 1: Put the site online

### Option A: GitHub Pages (simplest)

1. Create a free account at https://github.com.
2. Create a new **public** repository, for example `pdf-editor`. Do not add a README.
3. In this project folder, run:

   ```bash
   git init
   git add .
   git commit -m "First version of the PDF editor"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/pdf-editor.git
   git push -u origin main
   ```

4. On GitHub, open the repository, then go to **Settings → Pages**.
5. Under **Build and deployment**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save.
6. After about a minute, the site is live at `https://YOUR-NAME.github.io/pdf-editor/`.

Every time you `git push`, the site updates by itself.

### Option B: Cloudflare Pages (faster worldwide, still free)

1. Push the code to GitHub (steps 1 to 3 above).
2. Create a free account at https://dash.cloudflare.com.
3. Go to **Workers & Pages → Create → Pages → Connect to Git**, and pick your repository.
4. Settings: **Framework preset** = None, **Build command** = empty, **Output directory** = `/`.
5. Click **Deploy**. The site is live at `https://pdf-editor.pages.dev` (or a similar name).

### Your own domain (optional)

A name like `mypdfeditor.com` costs about $10 per year (for example from Cloudflare or Namecheap).
Both GitHub Pages and Cloudflare Pages let you connect it for free in their settings.

### What gets published

- `node_modules/` is **not** published (it is in `.gitignore`). It is not needed.
- `vendor/` **must** be published. It holds the PDF libraries.
- `server.js` is only for running the site on your own computer. It does no harm online.

---

## Part 2: Count your users

### What to pick

| Tool | Cost | What you see | Privacy |
|---|---|---|---|
| **GoatCounter** (recommended) | Free for personal and small sites | Visitors, pages, countries, devices, **and how many PDFs were opened and downloaded** | No cookies, no personal data |
| Cloudflare Web Analytics | Free | Visitors, pages, countries | No cookies. Cannot count opens or downloads |
| Google Analytics | Free | A lot | Uses cookies and tracks people. It goes against the "private" promise, so avoid it |

The app already has a small hook for this. In `app.js`, the `track()` function sends **only an event name**
(`open-pdf` or `download-pdf`). It never sends the file, the file name, or any text from the PDF.
Today it does nothing, because no counter is set up yet.

### Set up GoatCounter (about 10 minutes)

1. Sign up at https://www.goatcounter.com. Pick a code, for example `mypdfeditor`.
   Your dashboard will be at `https://mypdfeditor.goatcounter.com`.

2. Keep the counter script on your own site (this keeps the page from loading code from other sites):

   ```bash
   curl -o vendor/count.js https://gc.zgo.at/count.js
   ```

3. In `index.html`, add this line just **before** the `app.js` script line.
   Replace `mypdfeditor` with your code:

   ```html
   <script data-goatcounter="https://mypdfeditor.goatcounter.com/count" async src="vendor/count.js"></script>
   ```

4. In `index.html`, allow the page to talk to the counter. In the `Content-Security-Policy` line,
   change these two parts (again with your code):

   - `img-src 'self' blob: data:` → `img-src 'self' blob: data: https://mypdfeditor.goatcounter.com`
   - `connect-src 'self'` → `connect-src 'self' https://mypdfeditor.goatcounter.com`

5. Commit and push. Open your site, open a PDF, and download it.
   Within a minute you will see in the GoatCounter dashboard:
   - the page visit,
   - an `open-pdf` event,
   - a `download-pdf` event.

### Be honest with users

Once you count visits, add a short note on the site so the privacy text stays true. For example:
"We count visits without cookies. Your files are never uploaded."

### Want to count more?

Call `track('some-name')` anywhere in `app.js`. For example, put `track('edit-text')` in `makeReplacement()`
to see how many people use text editing. Only send names of actions, never file content.
