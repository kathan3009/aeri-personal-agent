/**
 * The privacy policy and terms people accept when they create an account, served as plain pages at /privacy and
 * /terms. They describe what this code actually does; update them with any change to what Aeri stores or shares.
 */
const updated = 'October 4, 2026';
const contact = () => process.env.AERI_SUPPORT_EMAIL ? `<a href="mailto:${process.env.AERI_SUPPORT_EMAIL}">${process.env.AERI_SUPPORT_EMAIL}</a>` : 'the support address in the app';

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Aeri</title><style>:root{color-scheme:light dark;--ink:#16202a;--muted:#5b6670;--bg:#f7fafc}@media (prefers-color-scheme:dark){:root{--ink:#e8eef3;--muted:#9aa6b1;--bg:#0f1418}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:680px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}p,li{color:var(--ink)}.date{color:var(--muted);margin:0 0 24px}a{color:inherit}</style></head>
<body><main><h1>${title}</h1><p class="date">Last updated ${updated}</p>${body}</main></body></html>`;

export const privacyPage = () => page('Privacy policy', `
<p>Aeri is a personal shopping agent. This policy explains what Aeri keeps about you, who helps process it, and how to remove it.</p>
<h2>What Aeri keeps</h2>
<ul>
<li>Your email address, used to sign you in with one-time codes. Aeri has no passwords for you.</li>
<li>What you tell Aeri or show it: chat messages, preferences (like sizes, favourite stores, allergies), what you have at home, recipes, shopping lists, store comparisons and orders.</li>
<li>Photos, videos and voice notes you send, used to understand your request. Video frames are kept only for items you confirm.</li>
<li>Emails that arrive at your Aeri address, if you create one. Aeri reads them to find order numbers, delivery updates and store sign-in codes.</li>
<li>Which stores you connected. Your store sessions and any sign-in details you choose to remember are held by Kernel, the private browser service; Aeri never sees your store passwords.</li>
</ul>
<h2>Who helps process it</h2>
<ul>
<li>AI models through Neon AI Gateway (Google Gemini for photos, video and voice; OpenAI GPT for conversation and shopping) receive the content needed to answer each request.</li>
<li>Exa searches the web for stores and products using item names, not your identity.</li>
<li>Kernel runs the private browsers that visit stores and keeps your store sign-ins.</li>
<li>AgentMail hosts your Aeri email address and sends sign-in codes.</li>
<li>Sentry may receive error reports, without your messages, files or email address.</li>
</ul>
<p>Aeri doesn't sell your data or use it for advertising.</p>
<h2>What Aeri never does</h2>
<p>Aeri never checks out, pays or places an order. It fills a store cart and stops; you review and pay at the store yourself.</p>
<h2>Keeping and deleting</h2>
<p>Your data is kept while you have an account. In Settings you can download a copy and delete your account. Deleting it removes your memory, lists, files, Aeri email address and store connections (including the sessions Kernel holds) and signs you out everywhere.</p>
<h2>Contact</h2>
<p>Questions or requests: ${contact()}.</p>`);

export const termsPage = () => page('Terms of use', `
<p>By creating an Aeri account you agree to these terms.</p>
<h2>What Aeri does</h2>
<p>Aeri compares stores, builds shopping lists and fills store carts on your behalf. It never pays or places orders: you check every cart and complete the purchase yourself, at the store, under that store's terms.</p>
<h2>Your store accounts</h2>
<p>When you connect a store, you authorize Aeri to use your session at that store to search and add items to your cart. You're responsible for following each store's own terms, and you can disconnect a store at any time in Settings.</p>
<h2>Prices and availability</h2>
<p>Prices, stock and delivery options come from stores and can change. Aeri shows what it found; the store's checkout is the final word.</p>
<h2>Fair use</h2>
<p>Aeri has daily limits for AI and store visits so the service stays available. Don't use Aeri to break the law, to buy for resale at scale, or to get around a store's limits.</p>
<h2>No warranty</h2>
<p>Aeri is provided as is, without warranties. To the extent the law allows, Aeri isn't liable for indirect losses or for purchases you complete at a store.</p>
<h2>Changes and contact</h2>
<p>If these terms change, the app will ask you to accept the new version. Questions: ${contact()}.</p>`);
