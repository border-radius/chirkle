---
title: Link previews and video thumbnails
description: How a Chirkle server fetches link previews with curl and makes video poster frames with ffmpeg, how both stay safe, and how to turn them off.
section: Administration
order: 8
---

Both are on by default, and both work in the background, so they never slow down sending a message.

## Link previews

Under each link in a message, Chirkle shows the page's icon and title. The server fetches them with `curl`.

To keep the server safe from links that point inside your network, it fetches only:

- `http` and `https` addresses on their default ports;
- public addresses: it looks the name up first and refuses it when any address is private, and connects only to the
  address it checked. Redirects are checked the same way, one by one.
- the start of a page (256 KB, and 16 KB for icons), so a huge one can't fill the memory.

Turn them off with `LINK_PREVIEWS=off`.

## Video thumbnails

For each video sent, the server makes a poster frame with `ffmpeg`. Rooms show it instead of loading the video to draw
its first frame, and the [media grid](../guide/files.md#a-rooms-media) shows it on the video's tile. A worker also makes
the grid's image thumbnails ahead of time.

`ffmpeg` reads only the uploaded file, with one thread, for 20 seconds at most, and not as root.

Turn it off with `FFMPEG=off`. Videos then show their first frame in rooms, loaded by the browser, and plain tiles in
the grid.

## Installing curl and ffmpeg

Both are in the [Docker image](../deploy/docker.md). Elsewhere, install them on the server and make sure they're on the
`PATH` of the user Chirkle runs as. On Debian or Ubuntu:

```sh
sudo apt install curl ffmpeg
```

Without them, the features quietly do without. Restart Chirkle after installing them.
