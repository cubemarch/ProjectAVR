# Search

How this site gets found, what it declares about itself to the things doing the
finding, and why the paid half of the usual answer does not exist here.

Three subjects, in the order they actually matter:

1. **The Safe Browsing listing**, which currently outranks everything else on
   this page by a wide margin.
2. **Organic search and generative answers** — the tags, the crawlable text,
   `robots.txt`, the sitemap and the policy pages. All of this is in the tree
   and pinned by [`test/seo.test.js`](../test/seo.test.js).
3. **Paid search**, which for this domain is closed. That section exists to
   record *why*, so the question does not get re-opened every quarter.

Everything in part 2 is code. Parts 1 and 3 are decisions and errands, and most
of the errands need a Google login rather than a commit.

---

## 1. The listing comes first

`lustxr.com` is flagged by Google Safe Browsing for social engineering. While
that is true, the rest of this document is theory: a flagged domain shows an
interstitial in Chrome, Firefox and Safari, is suppressed in Search, and taints
mail sent from the same apex. No amount of structured data competes with a red
page.

The likely cause was a soft 404 — the catch-all returned `200` with the
application shell for addresses that did not exist, which is indistinguishable
from a phishing kit serving a fake page on arbitrary paths. **That status bug is
already fixed**: the catch-all now returns a real `404` for an address that is
not a channel, while still serving the shell as the body, so a visitor who
mistypes still gets a usable site. Status and body are independent, and the
crawler reads the status.

The appeal cannot be made from this repository. See
[§6](#6-what-needs-a-google-login).

**Status, 2026-10-19: the appeal and the Search Console verification have both
been submitted.** The listing was still live when checked the same day, which
is expected — review takes days, not hours. How to check it without an API key
and without loading the site:

```sh
curl -s 'https://transparencyreport.google.com/transparencyreport/api/v3/safebrowsing/status?site=lustxr.com'
```

The second field of the returned row is the status: `1` is clean, `3` is
listed. On 2026-10-19 the apex answered `3` and `www.lustxr.com` answered `1`.

That asymmetry is worth knowing about and **worth doing nothing about**. The
obvious move — repointing the canonical at the clean hostname — is the wrong
one twice over: it reads as evasion of a listing rather than a fix for one, and
it throws away what little the apex has accrued in exchange for a hostname that
would very likely inherit the flag anyway. The appeal is the fix. Wait for it.

---

## 2. The catalogue is not what the site says it is

Measured 2026-10-19 against the live feeds.

**Of the 24 titles in `aebn-newest`, 22 carry no VR, 180, 360, SBS or 3D token
anywhere in the record.** `trending` is 3 of 24. These are general-market
adult DVD releases. Meanwhile the title, the meta description, the JSON-LD
and the `<noscript>` all describe a directory of VR and stereoscopic 3D video
organised by format.

There is no VR-scoped AEBN feed available to us as things stand. `genreId` is
accepted and ignored by `straight.aebn.com/straight/api/movies/newest`, and
`vr.aebn.com` does not resolve. The three programs in
[`src/catalog/affiliates.js`](../src/catalog/affiliates.js) are sales-tool
feeds with no format dimension to filter on.

Re-check with:

```sh
curl -s 'https://straight.aebn.com/straight/api/movies/newest' \
  | python3 -c "import json,sys,re; d=json.load(sys.stdin); \
print(sum(bool(re.search(r'\bVR\b|180|360|SBS', str(m), re.I)) for m in d), 'of', len(d))"
```

This matters twice, and both are things Google acts on rather than merely
notices:

- **It is the snippet-to-landing-page mismatch
  [`index.html`](../index.html) warns about in its own head comment.** A
  result promising VR over a page of general 2D covers is what a visitor
  bounces from and what a ranking adjustment is made of. The head comment was
  written about the `AFFILIATES_ONLY` flag hiding the catalogue; the feed turns
  out to produce the same mismatch by a different route.
- **It removes the defence against thin-affiliate classification.** Google's
  affiliate guidance turns on *substantial added value*. The whole of this
  site's added-value claim is format and headset compatibility, and
  `_affiliateCardHtml` renders a title, a partner and a duration. With the
  claim removed, what is left is a mirror of a feed that thousands of
  affiliates carry — which is the same policy exposure
  [§5](#5-things-that-would-cost-more-than-they-return) refuses a page-per-room
  for, arriving through the front door.

It is also the root of the cloaking fix recorded in §3. That was treated as
stale copy and corrected as copy; the copy was downstream of this.

**Two honest fixes, in preference order.** Source a VR-native affiliate
programme — SexLikeReal, VRBangers, BaDoinkVR and CzechVR all run one, with
VR-only catalogues and real format metadata, which makes the claim true and
the added value real in the same move. Failing that, change the positioning to
match the feed. What is not available is leaving both as they are and writing
more metadata about it: every tag added on top of the mismatch makes the
mismatch bigger.

Nothing in this repository can detect this regressing, because the feed is a
third party's and its contents are not ours to pin. It needs re-measuring
whenever a programme is added or swapped.

---

## 3. What is in the tree

### The site declares itself adult

Both documents carry two tags:

```html
<meta name="rating" content="adult" />
<meta name="rating" content="RTA-5042-1996-1400-1577-RTA" />
```

Google's explicit-content guidelines ask for one or the other and treat them as
interchangeable. Both are here because they are read by different things: the
first by Google, the second by parental-control software, device-level filters
and several ad networks, none of which have heard of the first.

The reason to declare at all is not politeness. Absent a declaration, the
classification is made by automated detection reading the page — and this
page's HTML is four empty divs until JavaScript runs. Being classified explicit
when you are not loses traffic; being classified clean when you are not is the
kind of error that gets a domain handled by a person.

`isFamilyFriendly: false` in the JSON-LD says the same thing a third time, in
the vocabulary a knowledge panel is built from. Saying one and not the others
invites the discrepancy to be resolved by guesswork.

### The catalogue is indexable; the broadcast document is not

[`live.html`](../live.html) is `noindex, follow`, and `/live` is disallowed in
`robots.txt`. These do different jobs and both are wanted: the disallow stops a
crawl, the `noindex` is read by anything that reached the document without
consulting `robots.txt` first. A session address is dead minutes after it is
created, so indexing one spends crawl budget to produce a result that 404s for
whoever clicks it.

### Content for crawlers that do not run JavaScript

This is the part that is easy to skip and expensive to skip.

Googlebot renders JavaScript and sees the real catalogue. **Almost nothing else
does.** GPTBot, ClaudeBot, PerplexityBot, CCBot and the rest fetch HTML and read
it as text, and the HTML of a single-page app says nothing. To every crawler
that feeds a generative answer, this domain had no content at all.

Two things fix that, both in [`index.html`](../index.html):

- a **`<noscript>` summary** — what the site is, what the formats mean, that the
  links are paid, that we host nothing, and links to the five policy pages;
- a **JSON-LD `@graph`** with `WebSite` and `Organization` nodes.

The `<noscript>` has to stay a *true* summary of what the page shows. The moment
it describes something the rendered page does not, it stops being a fallback and
becomes cloaking, which is a different and much worse problem.

That has already happened once, which is why it is now a test rather than only a
paragraph. The summary claimed the site "sorts it by format" and that "every
entry here is labelled with its projection and its stereo layout". Neither was
true: `_affiliateCardHtml` renders a title, a partner and a duration, and
`AFFILIATES_ONLY` draws the format filters disabled under a Coming Soon badge.
The text now says what is on the page today and that the catalogue of our own is
in progress, and [`test/seo.test.js`](../test/seo.test.js) fails on either of the
two stale claims coming back.

The failure mode is worth naming because it is so quiet: nothing breaks, the site
looks right in every browser, and the only reader who ever sees both the claim
and the page is a crawler. **Whenever `AFFILIATES_ONLY` is flipped, read the
`<noscript>` before shipping** — it is the one piece of copy on the site that
describes a mode rather than a product.

### Browsing agents are refused, and that is the rating working

ChatGPT's agent browser does not reach this domain. Asked to open `lustxr.com` it
returns `Forbidden. Calls to this URL are not allowed.` — which is OpenAI's own
egress policy, not anything this server did; a plain request for the same URL
returns `200` and the full document.

Almost certainly the adult declaration above, possibly compounded by the Safe
Browsing listing. **It is not a bug and the tags should not be touched to work
around it.** Being refused by consumer AI browsers is the price of declaring
honestly, and the alternative — being classified by guesswork — is the outcome
that section exists to avoid.

It does mean the three AI-facing paths are not one path, and only the middle one
is reachable:

| Path | Status |
| --- | --- |
| ChatGPT agent / live browse | Blocked at OpenAI's end, before the request |
| GPTBot and the other named crawlers | Allowed in `robots.txt`, fetch HTML, run no JavaScript |
| Googlebot | Renders JavaScript, sees the real page |

So for everything in the middle row, the `<noscript>` and the JSON-LD are not a
fallback — they are the entire site. A text extraction of the served HTML yields
about 1,400 characters, all of it from those two blocks.

### robots.txt names the AI crawlers on purpose

[`public/robots.txt`](../public/robots.txt) has the wildcard stanza and then a
second one naming fourteen agents explicitly. Three reasons, in the file itself,
in order of importance:

- A wildcard `Allow` reads as an oversight. Naming them puts a decision on the
  record: this site wants to be quotable in an AI answer, and the price is being
  read for training. That is a trade worth making for a site nobody can
  advertise on Google, and it should be written down as a trade.
- Several of them honour their own name and ignore `*`.
- **Google-Extended is not Googlebot.** Blocking it does not affect Search
  ranking at all, and allowing it grants nothing Googlebot has. It is the
  separate opt-in for AI Overviews and Gemini grounding, and a site that leaves
  it out is absent from those specifically — while ranking normally in Search,
  which is why nobody notices by looking at rankings.

### The sitemap is generated, not a file

`/sitemap.xml` is a route in [`server/index.js`](../server/index.js), not a
static document, because the channel list changes. It emits the home page, the
five policy pages, and every public primary channel slug from
`channelSlugs.publicPrimaries()` — which filters to enabled users, so a disabled
account's channel leaves the sitemap on its own. A sitemap listing addresses
that 404 is worse than no sitemap.

If the database query throws, the route logs and emits the static entries
anyway. A sitemap missing its channels is still a useful sitemap; a 500 is not.

### IndexNow pushes changes to Bing without waiting to be crawled

[`server/indexnow.js`](../server/indexnow.js), run with `npm run indexnow`.

Bing, Yandex, Seznam and Naver share one submission endpoint. Google does not
participate and has said so, so **this changes nothing about Google ranking**.
It is here for one reason: ChatGPT's web results come from Bing, and so do
Copilot's. For a domain that cannot buy search advertising ([§4](#4-paid-search-does-not-exist-for-this-domain)),
cannot be browsed by ChatGPT's own agent (above), and is invisible to every
crawler that does not run JavaScript, a free push into the index those answers
are drawn from is the shortest path between publishing something and an
assistant being able to cite it.

The key is served in plaintext at `/<key>.txt` and that is the whole
verification mechanism — it is not a secret, and it is committed rather than
configured because a published value gains nothing from being an environment
variable and loses the one property that matters: that the file and the
submission cannot disagree. `test/seo.test.js` pins that they match, because a
key file that 404s makes every submission fail with a 403 nobody is watching
for.

**Submission is manual on purpose.** A restart is not a content change, and the
protocol asks submitters not to resend unchanged URLs. A hook on boot would
send the same six addresses on every deploy and teach the endpoint to ignore
this host. Run it when something has actually changed — and note that the CLI
checks the live host serves the key before submitting, so it must be run after
a deploy rather than before.

### The link preview has an image, and the icons are the brand

`twitter:card` claimed `summary_large_image` for months with no image declared
anywhere. That is the worst of the three available states: clients that honour
the card render a bare URL or a broken box rather than falling back to a small
one, so every paste of this link into a chat window spent the preview and got
nothing. `og:image` is now `/og-card.png`, 1200x630, which is what Facebook,
LinkedIn, Slack, Discord and X all crop to.

The icons replaced an inline SVG of the letter `L` on a purple square that
predated the brand mark existing. Both the card and the icons are in
`public/`, so Express serves them at the root and Vite copies them into
`dist/`.

Three things here can break silently and are therefore tested: an `og:image`
pointing at a 404, declared dimensions that disagree with the file (a scraper
lays the preview out to the declared box and then paints the real one into
it), and an icon `href` with no file behind it — a failure mode the data URI
it replaced did not have.

### The policy pages

Five pages under [`public/legal/`](../public/legal/), served at `/terms`,
`/privacy`, `/2257`, `/dmca` and `/support`. They carry their own stylesheet
rather than importing the app's, so they render even when the bundle is broken —
which is exactly the circumstance in which somebody is most likely to be looking
for the contact address.

They matter to search more than their traffic suggests. For an adult domain,
whether the site looks like it is being minded is assessed, and a footer
pointing at five 404s is the precise shape of a site that put a template
together and built nothing behind it.

**[`2257.html`](../public/legal/2257.html) is an exemption statement, not a
records statement**, and that distinction is load-bearing. An affiliate
directory is neither a primary nor a secondary producer under 28 C.F.R.
§ 75.1(c), and § 75.1(c)(4) excludes activity limited to transmission, storage
or hosting without selecting the content. Thumbnails are hotlinked from the
partner's own servers, so no copy exists on our infrastructure. That is what
makes it lawful to publish the page without a custodian's name and home address.

The page says so explicitly, and commits to being replaced with a full custodian
statement before any first-party content is ever published. **If
`AFFILIATES_ONLY` is turned off and this site starts hosting its own video, that
page must be rewritten before the first file goes up, not after.**

### One contact address

Every published surface uses `contact@lustxr.com`. The structured data used to
say `support@`, which is the copy a knowledge panel and a generative answer are
most likely to quote and the only one with no page around it to show that it is
wrong. An unmonitored address there is a DMCA notice that never arrives, on a
site whose removal policy is the main thing it is judged on. There is a test.

### Metadata describes the site as it is

The title, description, Open Graph tags and `<noscript>` all describe a
**partner directory**, because [`src/site-mode.js`](../src/site-mode.js) has
`AFFILIATES_ONLY = true` and that is what a visitor gets. The catalogue, the
live creator rows and the recordings market are built and hidden.

A snippet promising live broadcasts over a page that is a directory is a
mismatch between the result and the landing page, which is both what Google
demotes for and what a visitor bounces from. **When that flag flips, the head
block and the `<noscript>` change with it.**

### Guides publish themselves, from the page

Pages under `public/guides/` are written for people choosing a headset or a
format, not for the catalogue. They are the one kind of page here that answers
a non-branded search, which nothing else on the site can. Each is routed at
an extension-less address by [`server/guides.js`](../server/guides.js) from
the moment it is listed there, and goes into the sitemap only once its own
robots tag stops saying `noindex`. That way the sitemap and the page can never
send a crawler opposite instructions.

A guide stays `noindex` until its first-hand notes are written. The dashed
`.todo` boxes mark where they go, and `npm test` fails if a guide becomes
indexable with one still on it. Those notes are what makes the page worth
ranking over the spec sheets it is drawn from.

### "XR" in the title, since 2026-11-05

"xr porn" was the first non-branded query Search Console showed with any
volume, at position 9.4. The head block now says "VR & XR". The `<noscript>`
has a sentence on what XR means, because it is the name of the site and the
term covers what is listed. It is one word, not a keyword list: §5 still
applies.

---

## 4. Paid search does not exist for this domain

Not "is difficult". Is prohibited, by policy, at every mainstream network.

| Network | Position |
| --- | --- |
| Google Ads | Sexually explicit content is prohibited. There is no review to win and no ad format that qualifies. |
| Microsoft Advertising | Same prohibition. Bing's paid inventory is closed for the same reason. |
| Meta, TikTok, X, LinkedIn, Reddit | All prohibit adult content in paid placements, whatever their organic policies are. |
| Amazon, Apple Search Ads | Not applicable and prohibited respectively. |

This is a category exclusion, not a quality judgement, and it does not change
with a better landing page or a cleaner account history. **Opening a Google Ads
account for this domain risks the account rather than the campaign**, and if
that account is tied to the same Google identity as Search Console and
Analytics, the blast radius is wider than one rejected ad.

### What is actually available

The adult ad networks, which sell inventory on the sites this one links to:

| Network | Notes |
| --- | --- |
| **TrafficJunky** | Aylo's inventory — Pornhub, YouPorn, RedTube. The largest single source of adult display traffic there is. CPM and CPC. |
| **ExoClick** | Very broad long-tail network, strong geo and device targeting. |
| **JuicyAds** | Already the sell-side here (ten zones). The same account buys. |
| **TrafficStars** | xHamster-aligned inventory. |
| **EroAdvertising**, **PlugRush**, **Clickadu** | Smaller, cheaper, noisier. |

All of them are self-serve, take a card, and will run a VR-targeted campaign
without a conversation.

### Why none of it has been bought

The arithmetic, which is the actual reason rather than squeamishness:

This site earns an affiliate commission on a conversion that happens two clicks
away, on somebody else's checkout. Buying display traffic to feed that means the
revenue per thousand impressions has to beat the CPM *after* losses at the
click, at the partner's landing page, and at the partner's payment form — three
drop-offs, none of which are instrumented here, on inventory where the audience
is already on an adult site and already has somewhere to be. That is media
arbitrage, it is a known-thin margin, and it is run by people who have been
measuring it for a decade.

It is also measurement-blocked today: the payments provider is a stub and the
identity provider is a mock, so there is no conversion event to optimise
against. **Buying traffic before conversions are instrumented is buying a number
you cannot read.**

**Decision: documented, not executed.** No account has been opened and no spend
has been committed. If this is revisited, the order is: instrument conversions
first, then test one network with a fixed small budget, then judge.

---

## 5. Things that would cost more than they return

- **Turning the AI performer biographies into indexable pages.** They are fine
  as they are used today: a hover card, not indexable, labelled as model-written
  wherever they appear, and few in number. Generating a page per performer from
  the same source would be scaled content abuse under Google's spam policy —
  which is a manual-action category, not a ranking adjustment.
- **Giving the live cam rooms URLs of their own.** This is the same policy
  breach wearing a more tempting disguise, and it is worth spelling out because
  the feed makes it a two-line change. A white label cam shelf is the textbook
  case of everything the spam policy names at once: thousands of affiliates
  serve a byte-identical room list, so a page per room is both scaled content
  abuse *and* duplicate content at scale — and the rooms are gone within the
  hour, so anything that did get indexed 404s before it is clicked. What
  `server/routes/cams.js` does instead: the route is `noindex` and under
  `/api/`, which `robots.txt` disallows; no room gets a URL, the player opens
  in-page; nothing reaches the sitemap, the `<noscript>` or the JSON-LD; and
  outbound links carry `sponsored nofollow noopener noreferrer`. The one part
  of the shelf that is ours — a VR-first selection, from a closed tag list,
  presented as a VR cam row rather than a mirror of somebody's front page — is
  the only part that would be worth publishing, and it is not worth a page.
- **Linking the Chaturbate white label from anything indexed.**
  `cams.lustxr.com` is a CNAME to `cname.whitelabel.chaturbate.com`, added
  2026-10-18. It is the bullet above wearing our own hostname: a full
  Chaturbate storefront, byte-identical to the one thousands of other
  affiliates serve, on a subdomain of a domain already carrying a Safe
  Browsing listing under appeal. Three things keep it clear of us, and all
  three are things we control:

  - **Nothing links it.** `chaturbateUrl()` in `server/routes/cams.js` bounds
    outbound links to `chaturbate.com` and its subdomains, which a white
    label on *our* domain fails. That was a side effect; it is now pinned as
    its own test in `test/cams.test.js`.
  - **It is not in the sitemap**, and nothing generates it into one.
  - **`robots.txt` cannot reach it.** That file is per-host and the host is
    theirs, so ours has no authority over it — do not add rules there
    expecting them to apply.

  Discovery is not under our control — Chaturbate issues a certificate for
  the hostname, which publishes it to Certificate Transparency logs, and
  those are crawled. But discovery turns out not to matter, because
  **Chaturbate already serves `X-Robots-Tag: noindex` on the white label**,
  verified 2026-10-19 across the root, a tag page, a category page, the
  signup page, a 404 and a path that does not exist. Every one either
  carries the header or 302s to `/?next=…`, which does. There is no path
  into that host that Google is permitted to index.

  **So do not proxy this record to add the header yourself.** It was the
  obvious move and it is the wrong one: the record is DNS-only because
  Chaturbate terminates TLS and issues the certificate, orange-clouding it
  risks breaking that, and the gain is a header that is already present on
  every response. Re-check with
  `curl -sI https://cams.lustxr.com/ | grep -i x-robots` if their behaviour
  ever looks like it has changed; nothing in this repository can test a
  third party's response headers.

- **Giving the Bang catalogue URLs.** Same breach again, and this one arrives
  wearing a brief: "serve the content from the API so that the user stays on
  our site". Most of that is honoured — `server/routes/bang.js` proxies the
  catalogue, `src/ui/browse.js` renders it as our own cards, searches 164,595
  scenes in-page and opens a title in a panel with the cast, the genres and a
  contact sheet of stills, so a visitor decides here rather than at somebody's
  age wall. What it does **not** do is give any of that an address, and the
  difference between those two things is the whole of this bullet. A page per
  scene would be 164,595 pages of a catalogue every Bang affiliate serves
  verbatim: scaled content abuse and duplicate content at scale, in the same
  manual-action category as the two bullets above, on a domain with a Safe
  Browsing listing freshly cleared. The same four controls apply — the routes
  are `noindex` and under `/api/`, which `robots.txt` disallows; no scene gets
  a URL, the panel opens in-page; nothing reaches the sitemap, the
  `<noscript>` or the JSON-LD; and outbound links carry
  `sponsored nofollow noopener noreferrer` from `AFFILIATE_LINK_REL`.

  Two things about the rows themselves belong here rather than in the code,
  because both are claims the page makes:

  - **There is no "top selling" sort and the headings do not pretend there
    is.** `GET /content/search/params/videos` reports the entire vocabulary
    as views, rating and release date. Revenue is not a dimension the
    affiliate tier can see, so a row called "Top Selling" would be a number
    we cannot read. The rows say what they sort by.
  - **The two Bang rows are different lists.** Measured 2026-10-20,
    `rating.allTime` returns 19 of the same 24 titles as `views.allTime` —
    the most-watched scenes are also the most-voted-on — so "Most Watched"
    and "Top Rated" rendered as one shelf printed twice. The second row is
    `views.monthly` instead, which overlaps the first by 1 of 24. Top Rated
    survives as a sort in the search box, where a term makes it a different
    question.

- **Doorway pages** per format, per city, per headset model. Same policy, same
  consequence.
- **Letting the `<noscript>` drift from the rendered page.** It is a fallback
  while it is true and cloaking the moment it is not.
- **Appealing the `mail.lustxr.com` listing separately.** The subdomain inherits
  the apex; clearing the apex clears it.

---

## 6. What needs a Google login

None of this can be done from the repository.

**Done, 2026-10-19:**

1. ~~**Appeal the Safe Browsing listing.**~~ Submitted. The soft-404 cause was
   fixed first, which is what the appeal has to be able to say. Check the
   result with the `curl` in [§1](#1-the-listing-comes-first) rather than by
   loading the site — review takes days, and a cleared listing is the gate on
   everything else here.
2. ~~**Verify the Search Console property.**~~ Submitted.

**Still outstanding, in priority order:**

3. **Submit `https://lustxr.com/sitemap.xml`** in Search Console. `robots.txt`
   already points at it, but submitting it is what starts the first crawl rather
   than waiting for one.
4. **URL-inspect and request indexing** for `/` and the five policy pages.
5. **Bing Webmaster Tools**, which imports a verified Search Console property in
   one step and is where ChatGPT's web results come from. Worth doing before
   the Google side pays off: `npm run indexnow` submits to the same index, and
   Bing is the one that feeds generative answers today.
6. **Google Postmaster Tools**, for the mail side — unrelated to ranking, same
   login, easy to do at the same time.

**Not a login, but the one that outranks all six:** the catalogue mismatch in
[§2](#2-the-catalogue-is-not-what-the-site-says-it-is). Indexing a page faster
does not help if the page does not deliver what the result promised.
