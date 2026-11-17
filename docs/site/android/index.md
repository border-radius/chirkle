---
title: The Chirkle Android app
description: Install the native Chirkle Android app, a 3 MB download that works with any Chirkle server, holds several accounts and notifies you without Google services.
section: Android app
order: 1
---

Chirkle's Android app is native (Kotlin and Jetpack Compose, not a web page in a wrapper), a 3 MB download, and does
what the web app does. It works with any server running Chirkle, and needs no Google services.

## Install it

Download the APK from the [latest release](https://github.com/border-radius/chirkle/releases/latest) on GitHub and open
it on your phone. Android asks you to allow installing apps from your browser or file manager the first time.

It needs Android 8.0 or newer.

## Sign in to your server

1. On the login screen, tap **Change server** and enter your server's address, for example `https://chat.example.com`.
2. Log in, or sign up.

The app talks to servers over `https://` only.

## Several accounts

The app holds as many accounts as you like, on one server or many, side by side. Add one from your profile.
Swipe right from the room list to see your accounts and switch between them.

## Notifications

The app notifies you of DMs, mentions of you and replies to you, and of every message in the rooms where you turned on
**Notify of every message**, even when it's closed. It doesn't use Google's push service: it checks each account's
server about every 15 minutes, so a notification can come a few minutes after the message. Nothing needs setting up on
the server.

Android may ask you to let the app run in the background. Allow it, or notifications can be late.

## Updates

New versions are published on the [releases page](https://github.com/border-radius/chirkle/releases). If your server
needs a newer app than yours, the app says **Update required** and links to the download.

## What's different from the web

- Photos and videos are compressed on the phone before upload, to save data.
- Swipe back to leave a room or a collection.
- Share images, videos and files into Chirkle from other apps.
- Invite links and room links open in the app when the server's admin has [set up App Links](for-admins.md) for your
  build of the app.
