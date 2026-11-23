# News Desk

A personal news page with five tabs: Canada, World, Pakistan, NA Sports, and Cricket & Tennis.

- A GitHub Action pulls headlines from public RSS feeds every 30 minutes and publishes the site to GitHub Pages.
- The **Refresh** button pulls the latest headlines right then, straight from the feeds (through free relay services). If a source can't be reached, its saved stories stay on screen.
- If the saved copy is more than 90 minutes old, a tab refreshes itself the first time you open it.

## Put it on GitHub (about 10 minutes, all in the browser)

1. Sign in at github.com and create a new **public** repository, for example `news-desk`. Leave "Add a README" unticked.
2. On the empty repo page, click **uploading an existing file**. Unzip `news-desk.zip` on your computer and drag **everything inside the folder** into the upload box (including the `.github`, `data` and `scripts` folders). Click **Commit changes**.
   - Tip: on a Mac, `.github` is hidden in Finder. Press `Cmd + Shift + .` to show it. On Windows, it shows normally.
   - If drag and drop skips the `.github` folder, create it by hand: **Add file → Create new file**, name it `.github/workflows/update-news.yml`, and paste in the contents of that file.
3. Go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. Go to the **Actions** tab. If asked, click the button to enable workflows. Open **Update news and publish** and click **Run workflow**.
5. After a minute or two, your site is live at `https://<your-username>.github.io/news-desk/`. The link also shows under **Settings → Pages**.

## Changing the sources

Everything lives in `feeds.json`. Each tab has a list of sources:

```json
{ "name": "Dawn", "url": "https://www.dawn.com/feeds/home" }
```

Add a `"tag"` (like `"NHL"` or `"Cricket"`) and the tab shows filter buttons for its tags. Edit the file on GitHub (pencil icon), commit, and the site rebuilds itself.

## Things to know

- **Forcing an update on GitHub:** Actions tab → Update news and publish → Run workflow.
- **GitHub schedules run a bit late** sometimes (5 to 15 minutes isn't unusual). The Refresh button covers that.
- **GitHub pauses scheduled jobs after 60 days without any commits** to the repo. If headlines stop updating, edit any file (or click "Enable workflow" on the Actions tab) to wake it up.
- **Some news sites block GitHub's servers.** When a feed fails during an update, the site keeps that source's previous stories, and Refresh in your browser usually still gets through. Failures are listed in the Action's log.
- **Live refresh uses free services** (rss2json.com, then cors.lol). They're rate-limited, which is fine for personal use. If one shuts down, change the `RELAYS` list at the top of `app.js`.

## Running the tests (optional)

```
npm install
npm test
```
