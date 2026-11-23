/* St. Mary's Syro Malabar Catholic Church — Multi-Ward Carol Configuration
 * ZERO hardcoded access codes, admin codes, or family PII in frontend code.
 * Set SUPABASE_URL and SUPABASE_ANON_KEY below (or configure via the in-app Setup modal).
 */

window.CAROL_APP_CONFIG = {
  churchName: "St. Mary's Syro Malabar Catholic Church",
  basePath: "/carol/",
  publicBaseUrl: "https://stmarys-hub.github.io/carol/",

  // Dedicated `stmarys-carol` Supabase Project URL and public Anon Key:
  SUPABASE_URL: "https://cdjspobojdzdzwucxhjx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNkanNwb2JvamR6ZHp3dWN4aGp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0NDk0NTcsImV4cCI6MjExMTAyNTQ1N30.GeGH0tQoe5T7tYdKAIoOM351HT_lBC9NyX5cFUcsxb8",

  // Central 5-Ward Registry
  WARDS: {
    W1: { id: "W1", short: "Ward 1", patron: "St. Kuriakose Chavara", full: "Ward 1 – St. Kuriakose Chavara", defaultWaGroup: "Ward 1- St. Kuriakose Chavara" },
    W2: { id: "W2", short: "Ward 2", patron: "St. Alphonsa",          full: "Ward 2 – St. Alphonsa",          defaultWaGroup: "Ward 2- St. Alphonsa" },
    W3: { id: "W3", short: "Ward 3", patron: "St. Mother Teresa",     full: "Ward 3 – St. Mother Teresa",     defaultWaGroup: "Ward 3- St. Mother Teresa" },
    W4: { id: "W4", short: "Ward 4", patron: "Blessed Kunjachan",     full: "Ward 4 – Blessed Kunjachan",     defaultWaGroup: "Ward 4- Blessed Kunjachan" },
    W5: { id: "W5", short: "Ward 5", patron: "St. Michael",           full: "Ward 5 – St. Michael",           defaultWaGroup: "Ward 5- St. Michael" }
  },

  // Standard public-domain carol lyrics (non-PII defaults available offline for all wards)
  DEFAULT_SONGS: [
    {
      id: "builtin-joy",
      title: "Joy to the World",
      lang: "English",
      karaoke_audio_url: "",
      lyrics: `Joy to the world, the Lord is come!
Let earth receive her King;
Let every heart prepare Him room,
And Heaven and nature sing,
And Heaven and nature sing,
And Heaven, and Heaven, and nature sing.

Joy to the earth, the Savior reigns!
Let men their songs employ;
While fields and floods, rocks, hills, and plains
Repeat the sounding joy,
Repeat the sounding joy,
Repeat, repeat the sounding joy.`
    },
    {
      id: "builtin-silent",
      title: "Silent Night",
      lang: "English",
      karaoke_audio_url: "",
      lyrics: `Silent night, holy night,
All is calm, all is bright
Round yon virgin mother and Child.
Holy Infant, so tender and mild,
Sleep in heavenly peace,
Sleep in heavenly peace.

Silent night, holy night,
Shepherds quake at the sight;
Glories stream from heaven afar,
Heavenly hosts sing Alleluia!
Christ the Savior is born,
Christ the Savior is born!`
    },
    {
      id: "builtin-jingle",
      title: "Jingle Bells",
      lang: "English",
      karaoke_audio_url: "",
      lyrics: `Dashing through the snow
In a one-horse open sleigh,
O'er the fields we go,
Laughing all the way.
Bells on bobtails ring,
Making spirits bright,
What fun it is to ride and sing
A sleighing song tonight!

Chorus:
Jingle bells, jingle bells,
Jingle all the way!
Oh! what fun it is to ride
In a one-horse open sleigh, hey!`
    },
    {
      id: "builtin-pulkkoodil",
      title: "Pulkkoodil",
      lang: "Malayalam",
      karaoke_audio_url: "",
      lyrics: `പുൽക്കൂട്ടിൽ വാഴും പൊന്നുണ്ണീ
പൂവമ്പിളി പോലൊരു ഉണ്ണീ
മാനത്തെ താരകമെല്ലാം
നിന്നെ നോക്കി ചിരിക്കുന്നു...

Pulkkootil vaazhum ponnunni
Poovambili poloru unni
Maanathe thaarakamellaam
Ninne nokki chirikkunnu...`
    },
    {
      id: "builtin-wish",
      title: "We Wish You",
      lang: "English",
      karaoke_audio_url: "",
      lyrics: `We wish you a Merry Christmas,
We wish you a Merry Christmas,
We wish you a Merry Christmas,
And a Happy New Year!

Good tidings we bring
To you and your kin;
Good tidings for Christmas
And a Happy New Year!`
    }
  ]
};

window.getSupabaseCredentials = function () {
  const cfg = window.CAROL_APP_CONFIG;
  const savedUrl = localStorage.getItem("carol_sb_url") || "";
  const savedKey = localStorage.getItem("carol_sb_anon_key") || "";
  return {
    url: (cfg.SUPABASE_URL || savedUrl).trim().replace(/\/+$/, ""),
    anonKey: (cfg.SUPABASE_ANON_KEY || savedKey).trim()
  };
};
