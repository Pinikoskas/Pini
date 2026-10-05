// Send WhatsApp messages to yourself by driving WhatsApp Web in the same browser.
// First run: scan the QR code once (WhatsApp on phone → Linked devices). The login is
// kept in the browser profile, like the Facebook login.

const COMPOSE_BOX = 'footer div[contenteditable="true"], div[contenteditable="true"][data-tab="10"]';
const QR_CODE = 'canvas[aria-label*="QR" i], canvas[aria-label*="scan" i], div[data-ref] canvas';
const INVALID_NUMBER = /invalid|אינו תקין|לא תקין/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "050-123 4567" / "+972501234567" -> "972501234567" (wa.me format, digits only). */
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = '972' + digits.slice(1); // Israeli local number
  return digits;
}

class WhatsAppWeb {
  constructor(context, phone, { baseUrl = 'https://web.whatsapp.com', log = console.log } = {}) {
    this.context = context;
    this.phone = normalizePhone(phone);
    this.baseUrl = baseUrl;
    this.log = log;
    this.page = null;
  }

  chatUrl() {
    return `${this.baseUrl}/send?phone=${this.phone}`;
  }

  /** Opens WhatsApp Web on your own chat; waits (up to 10 min) for a QR scan if needed. */
  async ensureReady() {
    if (!this.page || this.page.isClosed()) this.page = await this.context.newPage();
    await this.page.goto(this.chatUrl(), { waitUntil: 'domcontentloaded' });
    let askedForQr = false;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (await this.page.locator(COMPOSE_BOX).first().isVisible().catch(() => false)) return;
      const bodyText = await this.page.locator('[role="dialog"]').first().innerText({ timeout: 500 }).catch(() => '');
      if (INVALID_NUMBER.test(bodyText)) {
        throw new Error(`ווצאפ: המספר ${this.phone} לא תקין. בדוק את whatsapp.phone ב-config.yaml`);
      }
      if (!askedForQr && (await this.page.locator(QR_CODE).first().isVisible().catch(() => false))) {
        this.log('סרוק את קוד ה-QR בלשונית של ווצאפ: בטלפון → ווצאפ → מכשירים מקושרים → קישור מכשיר');
        askedForQr = true;
      }
      await sleep(2000);
    }
    throw new Error('ווצאפ ווב לא נטען תוך 10 דקות (לא נסרק QR?)');
  }

  async send(text) {
    let box = this.page && !this.page.isClosed() ? this.page.locator(COMPOSE_BOX).first() : null;
    if (!box || !(await box.isVisible().catch(() => false))) {
      await this.ensureReady();
      box = this.page.locator(COMPOSE_BOX).first();
    }
    await this.page.bringToFront();
    await box.click();
    const lines = text.trim().split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.page.keyboard.insertText(lines[i]);
      if (i < lines.length - 1) await this.page.keyboard.press('Shift+Enter');
    }
    await sleep(500);
    await this.page.keyboard.press('Enter');
    await sleep(2000);
    // If the text is still sitting in the box, the message wasn't sent.
    const left = (await box.innerText().catch(() => '')).trim();
    if (left) throw new Error('ההודעה לא נשלחה (נשארה בתיבת הכתיבה)');
  }
}

module.exports = { WhatsAppWeb, normalizePhone };
