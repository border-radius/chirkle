/// <reference path="../../types/pocketbase.d.ts" />
// The emoji a reaction may be (DESIGN.md §20.1): exactly those the picker offers (web/src/lib/emoji.ts, one line per
// category there). tests/unit/lib/emoji.test.ts fails if the two drift apart.

const EMOJI = [
  "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊",
  "👋 🤚 🖐️ ✋ 🖖 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 💪 🧠 👀 👅 👄 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙋 🙇 🤦 🤷 💁 🙆 🙅 🕺 💃 👯 🏃 🚶",
  "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🐢 🐍 🦎 🐙 🦑 🦀 🐠 🐟 🐬 🐳 🦈 🐊 🦒 🐘 🦔 🐾 🌵 🎄 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🍃 🌷 🌹 🌺 🌸 🌼 🌻 🌞 🌝 🌚 🌙 🌎 🪐 ☀️ ⛅ ❄️ ☃️ ⛄ 🌈 🌊 💧 ☔",
  "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥦 🧄 🧅 🍄 🥜 🍞 🥐 🥖 🥨 🥯 🥞 🧇 🧀 🍖 🍗 🥩 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🥧 🍫 🍬 🍭 🍮 🍯 🍼 ☕ 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾 🧊",
  "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🏒 🥅 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 ⛸️ 🎿 🏂 🏆 🥇 🥈 🥉 🏅 🎖️ 🎫 🎪 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩 🎉 🎊 🎈 🎁 🎀 🎃 🎆 🎇 🧨",
  "🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚚 🚜 🛵 🏍️ 🚲 🛴 🚨 🚃 🚄 🚂 ✈️ 🛫 🛬 🚀 🛸 🚁 ⛵ 🚤 🚢 ⚓ 🗺️ 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🏕️ 🏠 🏡 🏢 🏥 🏦 🏨 🏫 🏛️ ⛪ 🕌 🌃 🌆 🌇 🌉 🌌",
  "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 📸 🎥 📞 ☎️ 📺 📻 🎙️ ⏰ ⏳ 🔋 🔌 💡 🔦 🕯️ 💸 💵 💰 💳 💎 ⚖️ 🔧 🔨 🛠️ ⚙️ 🔩 🧲 🧪 🔬 🔭 💊 💉 🧬 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 ✉️ 📦 📫 📝 📁 📅 📌 📎 ✂️ 🔒 🔓 📚 📖 🔖 🏷️ 📈 📉 📊 🗑️ 🔔 🔕 📣 🕶️ 👓 👑 🎩 👟 👠 👕 👖 💼 🎒 ☂️",
  "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 💬 💭 💤 ✅ ❌ ❓ ❗ ‼️ ⁉️ ⚠️ 🚫 ⭕ 🔥 ✨ ⭐ 🌟 ⚡ 🎵 🎶 ➕ ➖ ✔️ ☑️ 🆗 🆒 🆕 🆙 🔝 ♻️ ⬆️ ⬇️ ➡️ ⬅️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🏁 🚩 🏳️ 🏴 🏳️‍🌈 🏴‍☠️",
].join(" ");

/** @type {Set<string> | null} */
let allowed = null;

/**
 * Is `s` one of the picker's emoji?
 * @param {unknown} s
 */
function isReactionEmoji(s) {
  if (!allowed) allowed = new Set(EMOJI.split(" "));
  return typeof s === "string" && allowed.has(s);
}

const VS16 = "\uFE0F";

/**
 * Emoji the picker hasn't got (bare, without variation selectors) and the picker's nearest to each: Telegram's
 * reactions (§26.9) and others the bridges bring over.
 */
const SIMILAR = new Map([
  ["🕊", "🐦"],
  ["❤‍🔥", "❤️"],
  ["💋", "😘"],
  ["🖕", "👎"],
  ["👨‍💻", "💻"],
  ["🫡", "🙇"],
  ["🎅", "🎄"],
  ["🗿", "😐"],
  ["👾", "👽"],
]);

/**
 * The picker's emoji for `emoji` (a reaction from Telegram or XMPP), or "" when neither it nor a near one is there:
 * "❤" is "❤️", a shrug of either gender is "🤷", skin tones are left aside, and a sequence (👩‍🚀) is the first of its
 * parts the picker has.
 * @param {string} emoji
 * @returns {string}
 */
function pickerEmoji(emoji) {
  const bare = emoji.replace(/\uFE0F/g, "").replace(/\u200D[♂♀]$/, "");
  const found = [emoji, bare, `${bare}${VS16}`].find((e) => isReactionEmoji(e)) || SIMILAR.get(bare) || "";
  if (found) return found;
  const plain = bare.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
  if (plain !== bare) return pickerEmoji(plain);
  const parts = plain.split("\u200D");
  return parts.length > 1 ? parts.map(pickerEmoji).find(Boolean) || "" : "";
}

module.exports = { EMOJI, isReactionEmoji, pickerEmoji };
