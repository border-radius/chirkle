// Names to find the picker's emoji by (DESIGN.md §20.6): in the emoji sheet's search field and by typing ":name" in
// the composer. One line per emoji, in the picker's order: the emoji, its short name (as in ":thumbsup:"), then more
// words it is found by. The same lines as web/src/lib/emoji-names.ts (EmojiTest fails if they drift apart).
package chirkle.android.data.lib

class NamedEmoji(val emoji: String, val name: String, val words: List<String>)

/** Every emoji with its names, in the picker's order. */
val EMOJI_NAMES: List<NamedEmoji> by lazy {
    NAMES.lines().map { line ->
        val parts = line.split(' ')
        val name = parts[1]
        NamedEmoji(parts[0], name, (listOf(name) + parts.drop(1).flatMap { it.split('_') }).distinct())
    }
}

private val BY_NAME by lazy { EMOJI_NAMES.associate { it.name to it.emoji } }

/** The emoji called exactly [name] (as in ":fire:"), if any. */
fun emojiNamed(name: String): String? = BY_NAME[name.lowercase()]

/**
 * The emoji [query] finds: each of its words must begin one of an emoji's words ("thumbs up", "heart_e"). Those it
 * names exactly come first, then those whose name begins with it (shorter names first), then the rest, in the
 * picker's order. As the web's findEmoji.
 */
fun findEmoji(query: String, max: Int = Int.MAX_VALUE): List<NamedEmoji> {
    val parts = query.trim().lowercase().split(Regex("[\\s_]+")).filter { it.isNotEmpty() }
    if (parts.isEmpty()) return emptyList()
    val joined = parts.joinToString("_")
    fun rank(n: NamedEmoji) = if (n.name == joined) 0 else if (n.name.startsWith(joined)) 1 else 2
    return EMOJI_NAMES
        .filter { n -> parts.all { p -> n.words.any { it.startsWith(p) } } }
        .sortedWith(compareBy<NamedEmoji> { rank(it) }.thenBy { if (rank(it) == 1) it.name.length else 0 })
        .take(max)
}

/** ":name" before the caret: where it starts and the name typed so far. */
class EmojiToken(val start: Int, val query: String)

/** ":" and two or more name characters just before the caret, at the start or after a space or "(" (not "12:30"). */
// \z, not $: Java's $ also matches before a last line break.
private val TOKEN = Regex("""(?<=^|[\s(]):([\w+-]{2,})\z""")
private val WHOLE = Regex("""(?<=^|[\s(]):([\w+-]+):\z""")

fun emojiToken(text: String, caret: Int): EmojiToken? =
    TOKEN.find(text.substring(0, caret))?.let { EmojiToken(it.range.first, it.groupValues[1].lowercase()) }

/** A whole ":name:" naming an emoji just before the caret: where it starts, and the emoji. */
fun wholeEmojiName(text: String, caret: Int): Pair<Int, String>? {
    val m = WHOLE.find(text.substring(0, caret)) ?: return null
    return emojiNamed(m.groupValues[1])?.let { m.range.first to it }
}

/** How many emoji the composer offers for a ":name" at most. */
const val SUGGEST_MAX = 8

private const val NAMES = """😀 grinning smile happy face
😃 smiley happy smile joy
😄 smile happy joy laugh
😁 grin happy smile teeth
😆 laughing happy haha lol xd
😅 sweat_smile phew relief nervous
🤣 rofl rolling laugh lol haha
😂 joy tears laugh lol haha cry
🙂 slightly_smiling smile ok
🙃 upside_down silly sarcasm
😉 wink flirt
😊 blush happy smile shy
😇 innocent angel halo
🥰 smiling_hearts love crush adore
😍 heart_eyes love crush
🤩 star_struck wow amazing eyes
😘 kissing_heart kiss love
😗 kissing kiss
😚 kissing_closed_eyes kiss
😙 kissing_smiling_eyes kiss
😋 yum tasty delicious tongue
😛 stuck_out_tongue tongue silly
😜 stuck_out_tongue_winking_eye tongue wink silly crazy
🤪 zany crazy goofy wild
😝 stuck_out_tongue_closed_eyes tongue silly
🤑 money_mouth rich dollar
🤗 hugs hug hugging
🤭 hand_over_mouth oops giggle
🤫 shushing quiet shh secret
🤔 thinking hmm think wonder
🤐 zipper_mouth secret quiet
🤨 raised_eyebrow suspicious skeptic doubt
😐 neutral meh blank
😑 expressionless meh blank
😶 no_mouth silent speechless
😏 smirk smug sly
😒 unamused meh annoyed
🙄 roll_eyes eyeroll whatever
😬 grimacing awkward eek
😌 relieved calm content
😔 pensive sad thoughtful
😪 sleepy tired
🤤 drooling hungry
😴 sleeping sleep tired zzz
😷 mask sick ill
🤒 thermometer sick ill fever
🤕 head_bandage hurt injured
🤢 nauseated sick gross
🤮 vomiting sick puke
🥵 hot sweat heat
🥶 cold freezing ice
🥴 woozy dizzy drunk tipsy
😵 dizzy_face dizzy
🤯 exploding_head mind_blown shocked wow
🤠 cowboy hat
🥳 partying party celebrate birthday
😎 sunglasses cool
🤓 nerd geek glasses
🧐 monocle curious fancy
😕 confused puzzled
😟 worried concerned
🙁 slightly_frowning sad frown
😮 open_mouth wow surprised
😯 hushed surprised
😲 astonished shocked amazed wow
😳 flushed embarrassed blush
🥺 pleading puppy_eyes please
😦 frowning shocked
😧 anguished
😨 fearful scared afraid
😰 cold_sweat anxious nervous
😥 disappointed_relieved phew sad
😢 cry sad tear
😭 sob crying sad
😱 scream fear horror shocked
😖 confounded
😣 persevere struggle
😞 disappointed sad
😓 sweat tired
😩 weary tired
😫 tired_face exhausted
🥱 yawning tired bored sleepy
😤 triumph huff proud
😡 rage angry mad
😠 angry mad annoyed
🤬 cursing swearing angry
😈 smiling_imp devil evil horns
👿 imp devil angry evil
💀 skull dead death dying
💩 poop poo shit
🤡 clown joke
👻 ghost spooky boo halloween
👽 alien ufo
🤖 robot bot
😺 smiley_cat cat happy
😸 smile_cat cat happy
😹 joy_cat cat laugh
😻 heart_eyes_cat cat love
😼 smirk_cat cat smug
😽 kissing_cat cat kiss
🙀 scream_cat cat shocked
😿 crying_cat cat sad
😾 pouting_cat cat angry
🙈 see_no_evil monkey shy
🙉 hear_no_evil monkey
🙊 speak_no_evil monkey oops
👋 wave hello hi bye hand
🤚 raised_back_of_hand hand
🖐️ hand_splayed palm five
✋ raised_hand hand stop high_five
🖖 vulcan spock
👌 ok_hand ok perfect
🤏 pinching small tiny
✌️ v peace victory
🤞 crossed_fingers luck hope
🤟 love_you hand
🤘 metal rock horns
🤙 call_me shaka hang_loose
👈 point_left left
👉 point_right right
👆 point_up_2 up
👇 point_down down
☝️ point_up up one
👍 thumbsup thumbs_up +1 yes like ok good
👎 thumbsdown thumbs_down -1 no dislike bad
✊ fist raised_fist power
👊 punch fist_bump bro
🤛 left_fist fist_bump
🤜 right_fist fist_bump
👏 clap applause bravo
🙌 raised_hands hooray yay praise
👐 open_hands hug
🤲 palms_up pray
🤝 handshake deal agreement
🙏 pray please thanks hope
✍️ writing_hand write
💅 nail_polish nails beauty
💪 muscle strong flex biceps
🧠 brain smart mind
👀 eyes look see watching
👅 tongue taste lick
👄 lips mouth kiss
👶 baby child
🧒 child kid
👦 boy kid
👧 girl kid
🧑 person adult
👨 man
👩 woman
🧓 older_person old
👴 older_man old grandpa
👵 older_woman old grandma
🙋 raising_hand hi me question
🙇 bow sorry thanks respect
🤦 facepalm ugh
🤷 shrug dunno whatever
💁 tipping_hand info sassy
🙆 ok_gesture ok yes
🙅 no_gesture no stop
🕺 man_dancing dance disco
💃 dancer dance woman
👯 dancers party bunny
🏃 runner running run
🚶 walking walk
🐶 dog puppy pet
🐱 cat kitten pet
🐭 mouse
🐹 hamster pet
🐰 rabbit bunny
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey_face monkey
🐔 chicken hen
🐧 penguin
🐦 bird
🐤 baby_chick chick bird
🦆 duck
🦅 eagle bird
🦉 owl bird
🦇 bat vampire
🐺 wolf
🐗 boar pig
🐴 horse
🦄 unicorn magic
🐝 bee honeybee
🐛 bug caterpillar
🦋 butterfly
🐌 snail slow
🐞 ladybug beetle
🐜 ant
🐢 turtle slow
🐍 snake
🦎 lizard
🐙 octopus
🦑 squid
🦀 crab
🐠 tropical_fish fish
🐟 fish
🐬 dolphin
🐳 whale
🦈 shark
🐊 crocodile
🦒 giraffe
🐘 elephant
🦔 hedgehog
🐾 paw_prints paws feet
🌵 cactus desert
🎄 christmas_tree xmas tree
🌲 evergreen_tree tree pine
🌳 deciduous_tree tree
🌴 palm_tree tree beach
🌱 seedling plant sprout
🌿 herb plant leaf
🍀 four_leaf_clover clover luck
🍁 maple_leaf leaf autumn fall
🍂 fallen_leaf leaf autumn fall
🍃 leaves leaf wind
🌷 tulip flower
🌹 rose flower love
🌺 hibiscus flower
🌸 cherry_blossom flower spring
🌼 blossom flower
🌻 sunflower flower
🌞 sun_with_face sun sunny
🌝 full_moon_with_face moon
🌚 new_moon_with_face moon
🌙 crescent_moon moon night
🌎 earth_americas world globe planet
🪐 ringed_planet saturn planet space
☀️ sunny sun weather
⛅ partly_sunny cloud weather
❄️ snowflake snow cold winter
☃️ snowman snow winter
⛄ snowman_without_snow snowman winter
🌈 rainbow
🌊 ocean wave sea water
💧 droplet water drop
☔ umbrella rain weather
🍏 green_apple apple fruit
🍎 apple red fruit
🍐 pear fruit
🍊 tangerine orange fruit
🍋 lemon fruit
🍌 banana fruit
🍉 watermelon fruit
🍇 grapes fruit
🍓 strawberry fruit
🍈 melon fruit
🍒 cherries fruit
🍑 peach fruit
🥭 mango fruit
🍍 pineapple fruit
🥥 coconut
🥝 kiwi fruit
🍅 tomato
🥑 avocado
🍆 eggplant aubergine
🥔 potato
🥕 carrot
🌽 corn
🌶️ hot_pepper chili spicy
🥒 cucumber
🥦 broccoli
🧄 garlic
🧅 onion
🍄 mushroom
🥜 peanuts nuts
🍞 bread toast
🥐 croissant
🥖 baguette bread
🥨 pretzel
🥯 bagel
🥞 pancakes breakfast
🧇 waffle breakfast
🧀 cheese
🍖 meat_on_bone meat
🍗 poultry_leg chicken drumstick
🥩 steak meat
🥓 bacon
🍔 hamburger burger
🍟 fries
🍕 pizza
🌭 hotdog
🥪 sandwich
🌮 taco
🌯 burrito
🥗 salad
🍝 spaghetti pasta
🍜 ramen noodles soup
🍲 stew soup pot
🍛 curry rice
🍣 sushi
🍱 bento box lunch
🥟 dumpling
🍤 fried_shrimp shrimp tempura
🍙 rice_ball onigiri
🍚 rice
🍘 rice_cracker
🍥 fish_cake
🍦 icecream soft_serve
🍧 shaved_ice
🍨 ice_cream dessert
🍩 doughnut donut
🍪 cookie
🎂 birthday cake
🍰 cake dessert
🧁 cupcake
🥧 pie
🍫 chocolate
🍬 candy sweet
🍭 lollipop candy
🍮 custard pudding flan
🍯 honey_pot honey
🍼 baby_bottle milk
☕ coffee tea hot
🍵 tea green_tea
🧃 juice_box juice
🥤 cup_with_straw soda drink
🍶 sake
🍺 beer
🍻 beers cheers
🥂 clinking_glasses champagne cheers toast
🍷 wine_glass wine
🥃 tumbler_glass whisky
🍸 cocktail martini
🍹 tropical_drink cocktail
🍾 champagne bottle celebrate
🧊 ice_cube ice cold
⚽ soccer football ball
🏀 basketball ball
🏈 football american_football ball
⚾ baseball ball
🥎 softball ball
🎾 tennis ball
🏐 volleyball ball
🏉 rugby ball
🥏 flying_disc frisbee
🎱 8ball billiards pool
🏓 ping_pong table_tennis
🏸 badminton
🏒 hockey ice_hockey
🥅 goal_net goal
⛳ golf
🏹 bow_and_arrow archery
🎣 fishing
🥊 boxing_glove boxing
🥋 martial_arts karate judo
🎽 running_shirt
🛹 skateboard
⛸️ ice_skate skating
🎿 ski skiing
🏂 snowboarder snowboard
🏆 trophy win winner champion
🥇 1st_place gold medal first
🥈 2nd_place silver medal second
🥉 3rd_place bronze medal third
🏅 medal sports_medal
🎖️ military_medal medal
🎫 ticket
🎪 circus_tent circus
🎭 performing_arts theater drama
🎨 art palette paint
🎬 clapper movie film
🎤 microphone sing karaoke
🎧 headphones music
🎼 musical_score music
🎹 musical_keyboard piano music
🥁 drum music
🎷 saxophone sax music
🎺 trumpet music
🎸 guitar music rock
🎻 violin music
🎲 game_die dice
♟️ chess_pawn chess
🎯 dart bullseye target
🎳 bowling
🎮 video_game game controller gaming
🎰 slot_machine
🧩 jigsaw puzzle
🎉 tada party hooray celebrate congrats
🎊 confetti_ball party celebrate
🎈 balloon party birthday
🎁 gift present birthday
🎀 ribbon bow
🎃 jack_o_lantern pumpkin halloween
🎆 fireworks celebrate
🎇 sparkler fireworks
🧨 firecracker dynamite
🚗 car red_car auto
🚕 taxi cab
🚙 suv car
🚌 bus
🏎️ racing_car race car
🚓 police_car police
🚑 ambulance
🚒 fire_engine firetruck
🚚 truck delivery
🚜 tractor
🛵 scooter moped
🏍️ motorcycle motorbike
🚲 bike bicycle
🛴 kick_scooter
🚨 rotating_light siren alert police
🚃 railway_car train tram
🚄 bullettrain train fast
🚂 steam_locomotive train
✈️ airplane plane flight travel
🛫 flight_departure plane takeoff
🛬 flight_arrival plane landing
🚀 rocket launch space ship
🛸 flying_saucer ufo
🚁 helicopter
⛵ sailboat boat
🚤 speedboat boat
🚢 ship boat cruise
⚓ anchor
🗺️ world_map map
🗽 statue_of_liberty new_york
🗼 tokyo_tower tower
🏰 castle
🏯 japanese_castle castle
🏟️ stadium
🎡 ferris_wheel
🎢 roller_coaster
🎠 carousel_horse carousel
⛲ fountain
🏖️ beach_umbrella beach vacation
🏝️ desert_island island beach
🏜️ desert
🌋 volcano
⛰️ mountain
🏔️ snow_capped_mountain mountain
🏕️ camping tent
🏠 house home
🏡 house_with_garden home
🏢 office building work
🏥 hospital
🏦 bank
🏨 hotel
🏫 school
🏛️ classical_building museum
⛪ church
🕌 mosque
🌃 night_with_stars night city
🌆 city_sunset city evening
🌇 city_sunrise sunset
🌉 bridge_at_night bridge
🌌 milky_way galaxy space stars
⌚ watch time
📱 iphone phone mobile
💻 computer laptop
⌨️ keyboard
🖥️ desktop_computer computer
🖨️ printer
🖱️ computer_mouse mouse
💾 floppy_disk save
💿 cd disc
📷 camera photo
📸 camera_flash photo
🎥 movie_camera video film
📞 telephone_receiver phone call
☎️ phone telephone
📺 tv television
📻 radio
🎙️ studio_microphone podcast mic
⏰ alarm_clock alarm time
⏳ hourglass time wait
🔋 battery
🔌 electric_plug plug
💡 bulb idea light
🔦 flashlight torch
🕯️ candle
💸 money_with_wings money spend
💵 dollar money cash
💰 moneybag money rich
💳 credit_card card pay
💎 gem diamond jewel
⚖️ balance_scale scale justice law
🔧 wrench tool fix
🔨 hammer tool
🛠️ hammer_and_wrench tools build
⚙️ gear settings cog
🔩 nut_and_bolt bolt
🧲 magnet
🧪 test_tube science experiment
🔬 microscope science
🔭 telescope space
💊 pill medicine drug
💉 syringe vaccine injection
🧬 dna gene
🔑 key
🗝️ old_key key
🚪 door
🛋️ couch sofa
🛏️ bed sleep
🧸 teddy_bear toy
✉️ envelope email letter mail
📦 package box parcel
📫 mailbox mail
📝 memo note write
📁 file_folder folder
📅 date calendar
📌 pushpin pin
📎 paperclip clip attach
✂️ scissors cut
🔒 lock locked secure
🔓 unlock unlocked open
📚 books library read
📖 book read open_book
🔖 bookmark
🏷️ label tag
📈 chart_with_upwards_trend chart up growth
📉 chart_with_downwards_trend chart down
📊 bar_chart chart stats
🗑️ wastebasket trash bin delete
🔔 bell notification
🔕 no_bell mute silent
📣 mega megaphone announce
🕶️ dark_sunglasses sunglasses cool
👓 eyeglasses glasses
👑 crown king queen
🎩 tophat hat
👟 sneaker shoe
👠 high_heel shoe
👕 shirt tshirt
👖 jeans pants
💼 briefcase work business
🎒 backpack school bag
☂️ open_umbrella umbrella rain
❤️ heart love red
🧡 orange_heart heart love
💛 yellow_heart heart love
💚 green_heart heart love
💙 blue_heart heart love
💜 purple_heart heart love
🖤 black_heart heart
🤍 white_heart heart
🤎 brown_heart heart
💔 broken_heart heartbreak sad
❣️ heavy_heart_exclamation heart
💕 two_hearts hearts love
💞 revolving_hearts hearts love
💓 heartbeat heart love
💗 heartpulse heart love
💖 sparkling_heart heart love
💘 cupid heart love arrow
💝 gift_heart heart love
💯 100 hundred perfect score
💢 anger angry
💥 boom collision bang
💫 dizzy star
💦 sweat_drops water splash
💨 dash wind fast
💬 speech_balloon chat comment talk
💭 thought_balloon think
💤 zzz sleep
✅ white_check_mark check done yes ok
❌ x cross no wrong
❓ question
❗ exclamation bang
‼️ bangbang exclamation
⁉️ interrobang exclamation question
⚠️ warning caution
🚫 no_entry_sign forbidden no
⭕ o circle
🔥 fire hot lit flame
✨ sparkles shiny magic new
⭐ star
🌟 star2 glowing_star
⚡ zap lightning electric
🎵 musical_note music note
🎶 notes music
➕ heavy_plus_sign plus add
➖ heavy_minus_sign minus
✔️ heavy_check_mark check yes
☑️ ballot_box_with_check check
🆗 ok
🆒 cool
🆕 new
🆙 up
🔝 top
♻️ recycle
⬆️ arrow_up up
⬇️ arrow_down down
➡️ arrow_right right
⬅️ arrow_left left
🔴 red_circle red
🟠 orange_circle orange
🟡 yellow_circle yellow
🟢 green_circle green
🔵 blue_circle blue
🟣 purple_circle purple
⚫ black_circle black
⚪ white_circle white
🏁 checkered_flag finish race
🚩 triangular_flag red_flag flag
🏳️ white_flag flag surrender
🏴 black_flag flag
🏳️‍🌈 rainbow_flag pride lgbt flag
🏴‍☠️ pirate_flag pirate flag"""
