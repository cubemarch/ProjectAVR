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
[§5](#5-what-needs-a-google-login).

---

## 2. What is in the tree

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

---

## 3. Paid search does not exist for this domain

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

## 4. Things that would cost more than they return

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

- **Doorway pages** per format, per city, per headset model. Same policy, same
  consequence.
- **Letting the `<noscript>` drift from the rendered page.** It is a fallback
  while it is true and cloaking the moment it is not.
- **Appealing the `mail.lustxr.com` listing separately.** The subdomain inherits
  the apex; clearing the apex clears it.

---

## 5. What needs a Google login

None of this can be done from the repository. In priority order:

1. **Appeal the Safe Browsing listing.**
   <https://safebrowsing.google.com/safebrowsing/report_error/>, or Search
   Console → Security Issues → Request Review once the property is verified.
   The soft-404 cause is fixed; say so in the appeal.
2. **Verify the Search Console property.** DNS TXT is the right method — it
   covers the apex and every subdomain and survives a redeploy. The Cloudflare
   zone is already under the account token at
   `~/.config/cloudflare/lustxr.env`.
3. **Submit `https://lustxr.com/sitemap.xml`** in Search Console. `robots.txt`
   already points at it, but submitting it is what starts the first crawl rather
   than waiting for one.
4. **URL-inspect and request indexing** for `/` and the five policy pages.
5. **Bing Webmaster Tools**, which imports a verified Search Console property in
   one step and is where ChatGPT's web results come from.
6. **Google Postmaster Tools**, for the mail side — unrelated to ranking, same
   login, easy to do at the same time.
