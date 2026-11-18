// The app's copy of shared/contract.json (docs/API.md): the fields it asks for and the limits it checks before the
// server does. ContractTests compares it with the file, as the web's and Android's contract tests do.
import Foundation

public enum Contract {
    public enum Fields {
        public static let message =
            "id,room,text,created,updated,edited_at,deleted,files,file_names,file_sources,file_dims,reactions,previews,author,expand.author.id,expand.author.name,expand.author.avatar,expand.author.no_dms,expand.author.instance,"
            + "reply_to,expand.reply_to.id,expand.reply_to.author,expand.reply_to.text,expand.reply_to.deleted,expand.reply_to.files,"
            + "expand.reply_to.expand.author.id,expand.reply_to.expand.author.name,"
            + "forwarded_from,forward_of,expand.forwarded_from.id,expand.forwarded_from.name,mentions"
        public static let room =
            "id,name,archived,created_by,kind,visibility,members,posting,writers,last_message_at,created,shared,"
            + "expand.members.id,expand.members.name,expand.members.avatar,expand.members.no_dms,expand.members.instance,"
            + "expand.writers.id,expand.writers.name,expand.writers.avatar,expand.writers.no_dms,expand.writers.instance"
        public static let user = "id,name,avatar,instance,handle"
        public static let roomRow = "id,room"
        public static let activity = "id,room,author,deleted"
        public static let collectionItem = "id,collection,file,name,video,poster,created"
    }

    public enum Limits {
        public static let messageText = 2000
        public static let userName = 32
        public static let roomName = 48
        public static let passwordMin = 8
        public static let passwordMaxBytes = 71
        public static let avatarBytes = 2_097_152
        public static let avatarTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"]
        public static let attachments = 10
        public static let attachmentBytes = 20_971_520
        public static let roomMembers = 100
        public static let maxSelected = 50
    }

    public enum Files {
        public static let image = ["jpg", "jpeg", "png", "gif", "webp", "avif"]
        public static let video = ["mp4", "m4v", "webm", "mov", "ogv"]
        public static let audio = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba"]
    }
}
