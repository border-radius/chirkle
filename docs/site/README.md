# Chirkle's documentation

These Markdown files are the documentation published at [chirkle.com/docs](https://chirkle.com/docs/). The site's
build turns each one into a page; this README is the only file it skips.

## How a file becomes a page

- **Its path is its address.** `install.md` is `/docs/install/`, `deploy/docker.md` is `/docs/deploy/docker/`, and an
  `index.md` is its folder's page (`deploy/index.md` is `/docs/deploy/`).
- **The block at the top** sets the page:

  ```yaml
  ---
  title: Run it with Docker          # the page's heading and the browser tab's title
  description: One or two sentences.  # what search engines show under the title; under 160 characters
  section: Get started                # the sidebar group it is listed in
  order: 4                            # its place in that group, smallest first
  ---
  ```

  The sidebar's groups come in this order: Get started, Using Chirkle, Android app, Administration, Linking and
  bridges, Reference, Help.
- **Links between pages** are relative links to the Markdown files (`[Docker](deploy/docker.md)`,
  `[the room's menu](../guide/rooms.md#the-rooms-menu)`), so they work on GitHub too. The build turns them into the
  site's addresses. Anchors are the headings, lower-cased, with spaces as hyphens.
- **Anything else** (the source, issues, the APK) links to GitHub with a full address.

## Writing them

- Write for the person reading: someone who chats, someone running a server, or someone building on the API. Each page
  says at the top who it is for when that isn't obvious.
- Use the app's own words for what's on screen, in bold: **Room access…**, **Jump to**, **Mentions & replies**. They
  are in `web/src/strings/`.
- A setting in the admin UI is written as its path: *Collections → site*, *Settings → Mail settings*.
- When a feature changes, change its page in the same commit. The design notes (`docs/design/`) keep the how and why;
  these pages say what to do.
