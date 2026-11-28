// Package contract is the console client's copy of shared/contract.json (docs/API.md): the field lists and limits
// every client agrees on with the server. contract_test.go fails when it and the shared file differ.
package contract

// Fields are the record fields the clients ask for.
var Fields = struct {
	Message, Room, User, RoomRow string
}{
	Message: "id,room,text,created,updated,edited_at,deleted,files,file_names,file_sources,file_dims,reactions,previews,author,expand.author.id,expand.author.name,expand.author.avatar,expand.author.no_dms,expand.author.instance,expand.author.kind,reply_to,expand.reply_to.id,expand.reply_to.author,expand.reply_to.text,expand.reply_to.deleted,expand.reply_to.files,expand.reply_to.expand.author.id,expand.reply_to.expand.author.name,expand.reply_to.expand.author.avatar,forwarded_from,forward_of,expand.forwarded_from.id,expand.forwarded_from.name,mentions",
	Room:    "id,name,archived,created_by,kind,visibility,members,posting,writers,last_message_at,created,shared,expand.members.id,expand.members.name,expand.members.avatar,expand.members.no_dms,expand.members.instance,expand.writers.id,expand.writers.name,expand.writers.avatar,expand.writers.no_dms,expand.writers.instance",
	User:    "id,name,avatar,instance,handle",
	RoomRow: "id,room",
}

// Limits are the server's limits, checked before sending so a form can say what is wrong.
var Limits = struct {
	MessageText, UserName, RoomName, PasswordMin, PasswordMaxBytes, Attachments, AttachmentBytes, MaxSelected int
}{
	MessageText: 2000, UserName: 32, RoomName: 48, PasswordMin: 8, PasswordMaxBytes: 71,
	Attachments: 10, AttachmentBytes: 20971520, MaxSelected: 50,
}

// Files are the extensions the clients show as images, videos and audio.
var Files = struct {
	Image, Video, Audio []string
}{
	Image: []string{"jpg", "jpeg", "png", "gif", "webp", "avif"},
	Video: []string{"mp4", "m4v", "webm", "mov", "ogv"},
	Audio: []string{"mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba"},
}
