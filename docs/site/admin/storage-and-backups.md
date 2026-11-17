---
title: Storage and backups
description: Where a Chirkle server keeps its data, how to schedule backups (to S3 if you like), store uploaded files on S3, and restore a backup.
section: Administration
order: 6
---

## Where the data is

Everything a Chirkle server keeps is in its data folder, `pb_data`:

- **`data.db`:** the SQLite database: accounts, rooms, messages, everything but files.
- **`storage/`:** uploaded files (attachments, profile pictures, collections), unless you
  [keep them on S3](#store-files-on-s3).
- **`backups/`:** backups made in the admin UI.

Where `pb_data` is depends on how you run Chirkle: the folder you ran `npx chirkle` in, `/opt/chirkle/pb_data` with
[systemd](../deploy/index.md), the `/pb_data` volume with [Docker](../deploy/docker.md) and
[Dokku](../deploy/dokku.md), or wherever `CHIRKLE_DATA` points.

## Backups

In the admin UI, *Settings → Backups*:

- **Back up now** makes one at once.
- **Backups options** schedules them, for example every night, and chooses how many to keep.
- Backups can go to S3-compatible storage (AWS S3, Backblaze B2, Cloudflare R2, MinIO and others) instead of the
  server's disk.

A backup is a ZIP of `pb_data`, uploaded files included, so it grows with them: plan the disk space, or send backups
to S3.

Take a backup before every update.

## Restore a backup

In *Settings → Backups*, a backup's menu has **Restore**. The server replaces its data with the backup's and restarts.

To move to another server, copy a backup's ZIP into the new server's `pb_data/backups/` (or upload it in the admin UI)
and restore it there. Or stop the server and copy the whole `pb_data` folder.

## Store files on S3

Uploaded files are kept in `pb_data/storage` by default. To keep them on S3-compatible storage instead, fill in
*Settings → Files storage*. Files are still served through Chirkle, which checks who may see each one, so the bucket
can stay private.

Files already uploaded aren't moved when you switch: PocketBase leaves that to you. Switch before people start
uploading, or copy `pb_data/storage` to the bucket yourself.
