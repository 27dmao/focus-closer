// Labeled test cases for the YouTube classifier.
// Each entry: { meta, expected, note }
// Ground truth is based on this user's rubric:
//   - Academic / technical / long-form educational = productive
//   - Gaming, vlogs, reactions, memes, pop music = unproductive
//   - Instrumental/lofi/focus music = productive; vocal/pop music = unproductive
//   - Shorts are always unproductive by format

export const TEST_CASES = [
  // Clear productive — academic
  {
    meta: { videoId: "t1", title: "Linear Algebra 14: Inner products and lengths", channel: "MIT OpenCourseWare", description: "Lecture 14 of Prof. Gilbert Strang's 18.06 course covering inner products, norms, and orthogonality.", tags: ["linear algebra", "mit", "lecture"], category: "Education", isShort: false },
    expected: "productive",
    note: "classic academic lecture"
  },
  {
    meta: { videoId: "t2", title: "But what is a neural network? | Chapter 1, Deep Learning", channel: "3Blue1Brown", description: "A visual introduction to neural networks. Part 1 of a series on deep learning.", tags: ["neural network", "deep learning", "machine learning"], category: "Education", isShort: false },
    expected: "productive",
    note: "whitelisted channel"
  },
  {
    meta: { videoId: "t3", title: "AP Psychology Unit 4: Learning (complete review)", channel: "Heimler's History", description: "Comprehensive review of operant conditioning, classical conditioning, observational learning.", tags: ["ap psychology", "learning", "review"], category: "Education", isShort: false },
    expected: "productive",
    note: "AP exam prep"
  },
  {
    meta: { videoId: "t4", title: "How Kafka works (distributed systems deep dive)", channel: "ByteByteGo", description: "Technical walkthrough of Apache Kafka internals, partitions, consumer groups.", tags: ["kafka", "distributed systems", "backend"], category: "Education", isShort: false },
    expected: "productive",
    note: "technical tutorial"
  },
  {
    meta: { videoId: "t5", title: "Stanford CS229: Machine Learning | Lecture 2 - Linear Regression", channel: "Stanford Online", description: "Andrew Ng's lecture on linear regression, gradient descent, and the normal equations.", tags: ["stanford", "machine learning", "andrew ng"], category: "Education", isShort: false },
    expected: "productive",
    note: "university lecture"
  },

  // Clear productive — long-form interview
  {
    meta: { videoId: "t6", title: "Yann LeCun: Meta AI, Open Source, Limits of LLMs, AGI | Lex Fridman Podcast", channel: "Lex Fridman", description: "Yann LeCun is a Turing Award winner and Chief AI Scientist at Meta. Three-hour conversation on AI research, JEPA, and path to AGI.", tags: ["ai", "research", "podcast"], category: "Science & Technology", isShort: false },
    expected: "productive",
    note: "technical long-form interview — often misclassified as entertainment"
  },
  {
    meta: { videoId: "t7", title: "Jensen Huang: GTC keynote on Blackwell and the future of compute", channel: "NVIDIA", description: "NVIDIA GTC keynote address on next-generation AI compute architecture.", tags: ["nvidia", "gtc", "keynote"], category: "Science & Technology", isShort: false },
    expected: "productive",
    note: "conference keynote"
  },

  // Clear productive — focus music
  {
    meta: { videoId: "t8", title: "lofi hip hop radio 📚 - beats to relax/study to", channel: "Lofi Girl", description: "24/7 live stream of lofi beats for studying, working, focusing.", tags: ["lofi", "study music", "chill beats"], category: "Music", isShort: false },
    expected: "productive",
    note: "focus music per user rule"
  },
  {
    meta: { videoId: "t9", title: "Deep Focus Music for Work and Studying — 4 Hours", channel: "Greenred Productions", description: "Background music engineered for deep work and productivity.", tags: ["focus music", "study", "deep work"], category: "Music", isShort: false },
    expected: "productive",
    note: "focus music"
  },
  {
    meta: { videoId: "t10", title: "Classical Music for Studying - Bach, Mozart, Chopin", channel: "HALIDONMUSIC", description: "Classical compositions ideal for concentration and study sessions.", tags: ["classical", "study", "bach"], category: "Music", isShort: false },
    expected: "productive",
    note: "classical = instrumental focus"
  },

  // Clear unproductive — gaming
  {
    meta: { videoId: "t11", title: "I Built The WORLD'S LARGEST Minecraft Automatic Farm", channel: "Mumbo Jumbo", description: "Building the biggest automatic farm in Minecraft survival mode.", tags: ["minecraft", "let's play", "redstone"], category: "Gaming", isShort: false },
    expected: "unproductive",
    note: "gaming content"
  },
  {
    meta: { videoId: "t12", title: "INSANE Fortnite Clutch 1v4 — you won't believe this", channel: "SypherPK", description: "Insane solo queue clutch moment in Fortnite.", tags: ["fortnite", "gameplay", "clutch"], category: "Gaming", isShort: false },
    expected: "unproductive",
    note: "gaming highlights"
  },
  {
    meta: { videoId: "t13", title: "GTA 6 Leaked Gameplay Reaction", channel: "Typical Gamer", description: "Reacting to leaked GTA 6 gameplay footage.", tags: ["gta 6", "reaction", "gameplay"], category: "Gaming", isShort: false },
    expected: "unproductive",
    note: "reaction + gaming"
  },

  // Clear unproductive — vlogs / lifestyle
  {
    meta: { videoId: "t14", title: "A Day In My Life as a 22-Year-Old in NYC", channel: "Emma Chamberlain", description: "Coffee, errands, and a photoshoot. Just a vibe.", tags: ["vlog", "day in the life", "nyc"], category: "People & Blogs", isShort: false },
    expected: "unproductive",
    note: "vlog"
  },
  {
    meta: { videoId: "t15", title: "MY 5AM MORNING ROUTINE (healthy habits I actually do)", channel: "Matt D'Avella", description: "Morning routine vlog with habits for a productive day.", tags: ["morning routine", "habits", "lifestyle"], category: "Howto & Style", isShort: false },
    expected: "unproductive",
    note: "lifestyle/routine content"
  },

  // Clear unproductive — reactions / memes
  {
    meta: { videoId: "t16", title: "SIDEMEN REACT TO TIKTOK COMPILATION 2025", channel: "Sidemen", description: "The Sidemen react to the funniest TikTok videos of 2025.", tags: ["sidemen", "reaction", "tiktok"], category: "Entertainment", isShort: false },
    expected: "unproductive",
    note: "reaction + meme compilation"
  },
  {
    meta: { videoId: "t17", title: "TRY NOT TO LAUGH CHALLENGE 2025 (IMPOSSIBLE)", channel: "SSSniperWolf", description: "Funniest videos of 2025, try not to laugh.", tags: ["try not to laugh", "funny", "memes"], category: "Entertainment", isShort: false },
    expected: "unproductive",
    note: "meme content"
  },

  // Unproductive — pop music videos (per user's instrumental-only rule)
  {
    meta: { videoId: "t18", title: "Taylor Swift - Anti-Hero (Official Music Video)", channel: "TaylorSwiftVEVO", description: "Official music video for Anti-Hero by Taylor Swift.", tags: ["taylor swift", "music video", "pop"], category: "Music", isShort: false },
    expected: "unproductive",
    note: "pop MV — unproductive under instrumental_only rule"
  },
  {
    meta: { videoId: "t19", title: "Drake - First Person Shooter ft. J. Cole", channel: "Drake", description: "Official music video.", tags: ["drake", "j cole", "rap"], category: "Music", isShort: false },
    expected: "unproductive",
    note: "pop/rap MV"
  },

  // Unproductive — Shorts (always)
  {
    meta: { videoId: "t20", title: "This coding trick will blow your mind 🤯", channel: "Fireship", description: "Quick JS tip.", tags: [], category: "", isShort: true },
    expected: "unproductive",
    note: "Shorts always unproductive even if topic is technical"
  },

  // Ambiguous — long-form podcast on science (should be productive)
  {
    meta: { videoId: "t21", title: "Andrew Huberman: Sleep, Dreams, Creativity, Fasting & Neuroplasticity", channel: "Huberman Lab", description: "Neuroscientist Dr. Andrew Huberman discusses neuroplasticity and sleep science.", tags: ["huberman", "neuroscience", "podcast"], category: "Science & Technology", isShort: false },
    expected: "productive",
    note: "science podcast — borderline, should classify as productive"
  },

  // Ambiguous — history documentary (productive)
  {
    meta: { videoId: "t22", title: "How the Roman Empire Actually Collapsed (It's Not What You Think)", channel: "Real Time History", description: "In-depth analysis of the economic, military, and political factors behind Rome's decline.", tags: ["history", "rome", "documentary"], category: "Education", isShort: false },
    expected: "productive",
    note: "history documentary"
  },

  // Ambiguous — coding livestream (productive)
  {
    meta: { videoId: "t23", title: "Building a Rust web framework from scratch — live coding", channel: "Jon Gjengset", description: "Six-hour live coding session building a minimal web framework in Rust.", tags: ["rust", "live coding", "web"], category: "Education", isShort: false },
    expected: "productive",
    note: "coding livestream"
  },

  // Ambiguous — true crime (unproductive — entertainment, not education despite length)
  {
    meta: { videoId: "t24", title: "The Zodiac Killer: A complete investigation", channel: "Bailey Sarian", description: "True crime deep dive into the Zodiac Killer case.", tags: ["true crime", "investigation"], category: "Entertainment", isShort: false },
    expected: "unproductive",
    note: "true crime — entertainment genre"
  },

  // Ambiguous — AI news recap (productive — technical news)
  {
    meta: { videoId: "t25", title: "Claude Opus 5, GPT-5 Turbo, Gemini 3 — this week in AI", channel: "AI Explained", description: "Recap of frontier AI releases, capability benchmarks, and research papers.", tags: ["ai", "news", "claude"], category: "Science & Technology", isShort: false },
    expected: "productive",
    note: "AI/tech news"
  },

  // Ambiguous — startup interview (productive)
  {
    meta: { videoId: "t26", title: "The Story of Stripe: Patrick & John Collison at Y Combinator", channel: "Y Combinator", description: "Patrick and John Collison share how they built Stripe, from Dublin to $1T economy.", tags: ["stripe", "yc", "startup"], category: "Education", isShort: false },
    expected: "productive",
    note: "YC interview — relevant for startup founder"
  },

  // Edge case — clickbait wrapped around real tutorial (productive, but gets tempting titles)
  {
    meta: { videoId: "t27", title: "This ONE Python trick will change how you code FOREVER", channel: "ArjanCodes", description: "Advanced Python pattern: context managers, protocols, and type narrowing for cleaner code.", tags: ["python", "programming", "tutorial"], category: "Education", isShort: false },
    expected: "productive",
    note: "clickbait title but real tutorial"
  },

  // Edge case — cooking tutorial (educational-ish, but lifestyle)
  {
    meta: { videoId: "t28", title: "How to make the perfect Neapolitan pizza at home", channel: "Vincenzo's Plate", description: "Step-by-step guide to authentic Neapolitan pizza.", tags: ["cooking", "pizza", "tutorial"], category: "Howto & Style", isShort: false },
    expected: "unproductive",
    note: "cooking — lifestyle, not work-productive for a software founder"
  },

  // Edge case — conspiracy / pseudo-educational (unproductive)
  {
    meta: { videoId: "t29", title: "The Shocking Truth About the Pyramids (They Lied To You)", channel: "Mystery History", description: "Evidence that mainstream archaeology is wrong about ancient Egypt.", tags: ["pyramids", "mystery", "ancient"], category: "Entertainment", isShort: false },
    expected: "unproductive",
    note: "pseudo-educational / conspiracy"
  },

  // Edge case — music that's NOT focus music but looks ambiguous
  {
    meta: { videoId: "t30", title: "Rainy Jazz Café Ambience with Bossa Nova Music", channel: "Cozy Rain", description: "Soothing jazz café ambience with rain sounds for relaxation and study.", tags: ["jazz", "ambience", "study"], category: "Music", isShort: false },
    expected: "productive",
    note: "ambient/instrumental = productive"
  }
];
