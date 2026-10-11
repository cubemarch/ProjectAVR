/**
 * US state age-verification statutes, as data.
 *
 * This file is the one place the legal position is written down in a form a
 * lawyer can read without reading any code. Nothing here imports anything,
 * nothing here calls anything, and nothing here decides anything - it is a
 * table. `jurisdiction.js` turns it into a policy and `age.js` enforces that
 * policy, and both of those are small because this is where the complexity
 * lives.
 *
 * Keep it that way. A state that needs a special case needs a *field* here,
 * read by a general rule over there; it does not need a branch on a state code
 * somewhere in a route handler. There are twenty-seven of these and there will
 * be more.
 *
 * **These citations are informational and the linked statute is authoritative.**
 * Where the published source does not make the code section unambiguous the
 * citation is null rather than guessed at, because a wrong citation in a
 * compliance file is worse than an absent one: it reads as having been checked.
 *
 * **This table is a snapshot, not a feed.** It was last reviewed on 2026-10-07
 * against the summary in `docs/STATE-AGE-LAWS.md`. Statutes are amended,
 * enjoined and allowed to take effect on their own schedule, and nothing in
 * this process notices. Re-reviewing it is a calendar item, not a code change.
 */

/**
 * The methods a statute can name.
 *
 * Deliberately coarser than the statutes themselves. Every one of these laws
 * describes the same two or three families of check in slightly different
 * words, and modelling each state's exact phrasing would produce twenty-seven
 * vocabularies that the verification provider cannot tell apart anyway. What
 * the code actually has to decide is which flow to open, and there are five.
 *
 * @typedef {'digitized_id'|'government_id'|'transactional'|'photo_match'|'financial'|'anonymous'} Method
 */
export const METHODS = {
    /** A mobile driver's licence or other digital identity credential. */
    digitized_id: {
        id: 'digitized_id',
        label: 'Digital ID',
        describe: 'A mobile driver’s licence or other digital identity credential.'
    },

    /** A photograph of a government-issued document, checked commercially. */
    government_id: {
        id: 'government_id',
        label: 'Government ID',
        describe: 'A photo of a government-issued ID, checked by our verification provider.'
    },

    /** A records-based or commercial-database lookup, with no document. */
    transactional: {
        id: 'transactional',
        label: 'Records check',
        describe: 'A check against commercial databases regularly used to verify age and identity.'
    },

    /** A contemporaneous photograph matched to a state photo ID. Tennessee. */
    photo_match: {
        id: 'photo_match',
        label: 'Photo and ID',
        describe: 'A photo taken now, matched against a valid state-issued photo ID.'
    },

    /** A card or account whose ownership is restricted to adults. */
    financial: {
        id: 'financial',
        label: 'Card or bank account',
        describe: 'A credit or debit card, or a bank account, that only an adult may hold.'
    },

    /** Verification by an independent third party that retains nothing. Florida. */
    anonymous: {
        id: 'anonymous',
        label: 'Anonymous verification',
        describe:
            'An independent third party confirms your age and tells us only yes or no. ' +
            'They are required by law to keep nothing afterwards.'
    }
};

/**
 * The twenty-seven states with an age-verification statute on the books.
 *
 * Absence from this table means "no statute", which resolves to the
 * self-attestation button. That is the correct default for a state with no
 * law and the dangerous one for a state whose law we have not noticed yet,
 * which is why the review date above exists.
 *
 * Fields:
 *
 *   `methods`            which of {@link METHODS} the statute permits
 *   `assuranceLevel`     `'ial2'` where the statute names NIST IAL2 by name
 *   `sessionMinutes`     a verified session's statutory ceiling, if any
 *   `requiresChoice`     the viewer must be *offered* a choice of method
 *   `noRetention`        identifying information may not be retained at all
 *   `agApproved`         the attorney general certifies acceptable methods
 *   `thirdPartyRequired` the operator may not self-verify
 *   `geolocation`        the statute imposes geolocation duties of its own
 *
 * @type {Record<string, {
 *   name: string, citation: string|null, source: string, methods: Method[],
 *   assuranceLevel?: 'ial2', sessionMinutes?: number, requiresChoice?: boolean,
 *   noRetention?: boolean, agApproved?: boolean, thirdPartyRequired?: boolean,
 *   geolocation?: boolean, note?: string
 * }>}
 */
export const STATE_LAWS = {
    AL: {
        name: 'Alabama',
        citation: '2024 Ala. HB 164',
        source: 'https://alison.legislature.state.al.us/files/pdf/SearchableInstruments/2024RS/HB164-enr.pdf',
        methods: ['government_id', 'digitized_id', 'transactional'],
        note:
            'Technology-neutral: commercial software, applications or other methods giving ' +
            'reasonable assurance the viewer is an adult. No one technology is prescribed.'
    },

    AZ: {
        name: 'Arizona',
        citation: 'Ariz. Rev. Stat. § 18-701',
        source: 'https://www.azleg.gov/ars/18/00701.htm',
        methods: ['digitized_id', 'government_id', 'transactional'],
        noRetention: true,
        note:
            'Identifying information may not be retained, and may not be transmitted to any ' +
            'government entity. This is the strictest retention rule of the twenty-seven and ' +
            'is why nothing identifying crosses back from the provider anywhere.'
    },

    AR: {
        name: 'Arkansas',
        citation: '2023 Ark. Act 612 (SB 66)',
        source: 'https://arkleg.state.ar.us/Home/FTPDocument?path=%2FACTS%2F2023R%2FPublic%2FACT612.pdf',
        methods: ['digitized_id', 'government_id', 'transactional'],
        assuranceLevel: 'ial2',
        note: 'A commercially reasonable method must meet NIST Identity Assurance Level 2.'
    },

    FL: {
        name: 'Florida',
        citation: 'Fla. Stat. § 501.1737',
        source: 'https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599%2F0501%2FSections%2F0501.1737.html',
        methods: ['government_id', 'digitized_id', 'transactional', 'anonymous'],
        requiresChoice: true,
        note:
            'Both standard and anonymous verification must be *offered*, and the viewer ' +
            'chooses. Anonymous verification must run at a qualifying independent US third ' +
            'party subject to the statute’s privacy protections. Offering only one of the ' +
            'two is a violation even if that one is the stronger check.'
    },

    GA: {
        name: 'Georgia',
        citation: '2024 Ga. SB 351',
        source: 'https://gov.georgia.gov/document/2024-signed-legislation/sb-351/download',
        methods: ['digitized_id', 'government_id', 'transactional'],
        assuranceLevel: 'ial2',
        note: 'Commercial verification must meet or exceed NIST IAL2.'
    },

    ID: {
        name: 'Idaho',
        citation: '2024 Idaho H 498',
        source: 'https://action.freespeechcoalition.com/bill/idaho-h-498/',
        methods: ['digitized_id', 'government_id', 'transactional']
    },

    IN: {
        name: 'Indiana',
        citation: 'Ind. Code § 24-4-23-7',
        source: 'https://law.justia.com/codes/indiana/title-24/article-4/chapter-23/section-24-4-23-7/',
        methods: ['digitized_id', 'transactional'],
        thirdPartyRequired: true,
        note:
            'A mobile credential, an independent third-party database, or transactional ' +
            'records. The statute routes every path through a third party.'
    },

    IA: {
        name: 'Iowa',
        citation: '2025 Iowa HF 864',
        source: 'https://www.legis.iowa.gov/docs/publications/LGE/91/attachments/HF864.html',
        methods: ['digitized_id', 'transactional'],
        agApproved: true,
        note: 'A third category exists for methods the attorney general approves by rule.'
    },

    KS: {
        name: 'Kansas',
        citation: '2024 Kan. SB 394',
        source: 'https://www.kslegislature.gov/b2023_24/documents/view-leg/?apn=b2023_24%2Fyear2%2Fready_for_publication%2Fsb_394%2Fsb394_enrolled.pdf',
        methods: ['transactional'],
        agApproved: true,
        note:
            'Commercial databases regularly used for age and identity checks. Any other ' +
            'commercial method needs AG approval or certification against AG standards, so ' +
            'the database path is the only one usable without a filing.'
    },

    KY: {
        name: 'Kentucky',
        citation: null,
        source: 'https://apps.legislature.ky.gov/law/statutes/statute.aspx?id=54994',
        methods: ['government_id', 'transactional'],
        note: 'A state-issued ID, a federal government ID establishing age, or records.'
    },

    LA: {
        name: 'Louisiana',
        citation: 'La. Rev. Stat. § 9:2800.28',
        source: 'https://www.legis.la.gov/Legis/Law.aspx?d=1293341',
        methods: ['digitized_id', 'government_id', 'transactional'],
        note: 'The first of these laws; most of the others are drafted from it.'
    },

    MS: {
        name: 'Mississippi',
        citation: 'Miss. Code Ann. § 11-77-3',
        source: 'https://law.justia.com/codes/mississippi/title-11/chapter-77/section-11-77-3/',
        methods: ['digitized_id', 'government_id', 'transactional']
    },

    MO: {
        name: 'Missouri',
        citation: 'Mo. Rev. Stat. § 407.3405',
        source: 'https://www.revisor.mo.gov/main/OneSection.aspx?section=407.3405',
        methods: ['digitized_id', 'government_id', 'transactional'],
        thirdPartyRequired: true,
        note: 'Verification must be performed by a third party; self-verification is not available.'
    },

    MT: {
        name: 'Montana',
        citation: null,
        source: 'https://mca.legmt.gov/bills/mca/title_0300/chapter_0140/part_0010/section_0590/0300-0140-0010-0590.html',
        methods: ['digitized_id', 'government_id', 'transactional']
    },

    NE: {
        name: 'Nebraska',
        citation: 'Neb. Rev. Stat. § 87-1002',
        source: 'https://nebraskalegislature.gov/laws/statutes.php?statute=87-1002',
        methods: ['digitized_id', 'government_id', 'transactional', 'financial'],
        note: 'Uniquely names a financial or other document reliably establishing age.'
    },

    NC: {
        name: 'North Carolina',
        citation: 'N.C. Gen. Stat. ch. 66, art. 51',
        source: 'https://library.ncleg.gov/EnactedLegislation/Statutes/HTML/ByArticle/Chapter_66/Article_51.html',
        methods: ['transactional', 'government_id'],
        note: 'Commercial databases, or another commercially reasonable method.'
    },

    ND: {
        name: 'North Dakota',
        citation: 'N.D. Cent. Code ch. 51-07',
        source: 'https://ndlegis.gov/cencode/t51c07.pdf',
        methods: ['digitized_id', 'government_id', 'transactional']
    },

    OH: {
        name: 'Ohio',
        citation: 'Ohio Rev. Code § 1349.10',
        source: 'https://codes.ohio.gov/ohio-revised-code/section-1349.10',
        methods: ['government_id', 'transactional'],
        geolocation: true,
        note:
            'Covered operators also carry geolocation duties of their own. The statute has a ' +
            'significant exemption; this table assumes we are covered, because assuming the ' +
            'exemption applies and being wrong is the expensive direction of the error.'
    },

    OK: {
        name: 'Oklahoma',
        citation: 'Okla. Stat. tit. 15',
        source: 'https://www.oklegislature.gov/OK_Statutes/CompleteTitles/os15.pdf',
        methods: ['digitized_id', 'transactional'],
        thirdPartyRequired: true
    },

    SC: {
        name: 'South Carolina',
        citation: 'S.C. Code Ann. tit. 37, ch. 1',
        source: 'https://www.scstatehouse.gov/code/t37c001.php',
        methods: ['digitized_id', 'transactional'],
        thirdPartyRequired: true
    },

    SD: {
        name: 'South Dakota',
        citation: 'S.D. Codified Laws ch. 22-24',
        source: 'https://sdlegislature.gov/api/Statutes/22-24.html?all=true',
        methods: ['government_id', 'financial', 'transactional'],
        note:
            'A driver’s licence or state ID, bank-account verification, or a card whose ' +
            'ownership requires an adult. Closes with a catch-all for any other reliable method.'
    },

    TN: {
        name: 'Tennessee',
        citation: 'Tenn. Code Ann. § 39-17-912',
        source: 'https://law.justia.com/codes/tennessee/title-39/chapter-17/part-9/section-39-17-912/',
        methods: ['photo_match', 'transactional'],
        sessionMinutes: 60,
        note:
            'The Protect Tennessee Minors Act. A contemporaneous photograph matched to a ' +
            'state photo ID, or records. The verified session may not outlive sixty minutes, ' +
            'which is the only recency rule in the twenty-seven and the reason policies carry ' +
            'a session ceiling at all.'
    },

    TX: {
        name: 'Texas',
        citation: 'Tex. Civ. Prac. & Rem. Code ch. 129B',
        source: 'https://tcss.legis.texas.gov/resources/CP/htm/CP.129B.htm',
        methods: ['digitized_id', 'government_id', 'transactional']
    },

    UT: {
        name: 'Utah',
        citation: 'Utah Code Ann. § 78B-3-1001',
        source: 'https://law.justia.com/codes/utah/title-78b/chapter-3/part-10/section-1001/',
        methods: ['digitized_id', 'transactional'],
        thirdPartyRequired: true
    },

    VA: {
        name: 'Virginia',
        citation: 'Va. Code Ann. § 8.01-40.5',
        source: 'https://law.lis.virginia.gov/vacode/title8.01/chapter3/section8.01-40.5/',
        methods: ['transactional', 'government_id']
    },

    WV: {
        name: 'West Virginia',
        citation: 'W. Va. Code § 49A-1-102',
        source: 'https://code.wvlegislature.gov/49A-1-102/',
        methods: ['digitized_id', 'government_id', 'transactional']
    },

    WY: {
        name: 'Wyoming',
        citation: 'Wyo. Stat. Ann. tit. 14',
        source: 'https://wyoleg.gov/statutes/compress/title14.pdf',
        methods: ['government_id', 'financial', 'transactional'],
        note: 'Names government, military and tribal IDs specifically, plus adult-only cards.'
    }
};

/** Every US state and territory code the resolver will recognise. */
export const US_REGIONS = new Set([
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI',
    'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN',
    'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
    'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
    'WV', 'WI', 'WY',
    // Territories. None has a statute of this kind; they are listed so that a
    // viewer in one resolves to a *known* region with no law rather than to
    // the unknown-region fallback, which fails closed.
    'AS', 'GU', 'MP', 'PR', 'VI'
]);
