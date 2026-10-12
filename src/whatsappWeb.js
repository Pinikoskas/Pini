// Send WhatsApp messages (to yourself, or to a group by its invite link) by driving WhatsApp Web
// in the same browser.
// First run: scan the QR code once (WhatsApp on phone → Linked devices). The login is
// kept in the browser profile, like the Facebook login.

const COMPOSE_BOX = 'footer div[contenteditable="true"], div[contenteditable="true"][data-tab="10"]';
const QR_CODE = 'canvas[aria-label*="QR" i], canvas[aria-label*="scan" i], div[data-ref] canvas';
const INVALID_NUMBER = /invalid|אינו תקין|לא תקין/i;
const BAD_INVITE = /invalid|expired|reset|revoked|לא תקין|פג תוקף|אופס|אינו פעיל|בוטל/i;
const JOIN_OR_OPEN = /join|הצטרפ|open chat|open group|view group|פתיחת הצ'אט|פתיחת צ'אט|פתח צ'אט|פתיחת הקבוצה|הצגת הקבוצה|צפייה בקבוצה/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "050-123 4567" / "+972501234567" -> "972501234567" (wa.me format, digits only). */
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = '972' + digits.slice(1); // Israeli local number
  return digits;
}

/** "https://chat.whatsapp.com/AbC123" -> "AbC123" (null if it isn't a group invite link). */
function groupInviteCode(link) {
  const m = String(link || '').match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{10,})/);
  return m ? m[1] : null;
}

class WhatsAppWeb {
  /** target: { phone } for your own chat, or { group_link } for a group (the group wins). */
  constructor(context, target, { baseUrl = 'https://web.whatsapp.com', log = console.log } = {}) {
    this.context = context;
    this.baseUrl = baseUrl;
    this.log = log;
    this.page = null;
    this.setTargetOnly(target);
  }

  setTargetOnly(target = {}) {
    this.phone = normalizePhone(target.phone);
    this.groupCode = groupInviteCode(target.group_link);
  }

  chatUrl() {
    return this.groupCode ? `${this.baseUrl}/accept?code=${this.groupCode}` : `${this.baseUrl}/send?phone=${this.phone}`;
  }

  /** Opens WhatsApp Web on the chat (or group); waits (up to 10 min) for a QR scan if needed. */
  async ensureReady() {
    if (!this.page || this.page.isClosed()) this.page = await this.context.newPage();
    await this.page.goto(this.chatUrl(), { waitUntil: 'domcontentloaded' });
    let askedForQr = false;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (await this.page.locator(COMPOSE_BOX).first().isVisible().catch(() => false)) return;
      const dialog = this.page.locator('[role="dialog"]').first();
      const bodyText = await dialog.innerText({ timeout: 500 }).catch(() => '');
      if (this.groupCode) {
        // The invite link opens a "join group" window (or the chat, if you're already in it).
        const button = dialog.getByRole('button', { name: JOIN_OR_OPEN }).first();
        if (await button.isVisible().catch(() => false)) {
          this.log('מצטרף לקבוצת הווצאפ / פותח אותה...');
          await button.click().catch(() => {});
          await sleep(3000);
          continue;
        }
        if (bodyText && BAD_INVITE.test(bodyText)) {
          throw new Error('ווצאפ: קישור הקבוצה לא תקין או פג תוקף. העתק קישור הזמנה חדש מהקבוצה (פרטי הקבוצה ← הזמנה באמצעות קישור)');
        }
      } else if (INVALID_NUMBER.test(bodyText)) {
        throw new Error(`ווצאפ: המספר ${this.phone} לא תקין. בדוק את מספר הטלפון בהגדרות`);
      }
      if (!askedForQr && (await this.page.locator(QR_CODE).first().isVisible().catch(() => false))) {
        this.log('סרוק את קוד ה-QR בלשונית של ווצאפ: בטלפון → ווצאפ → מכשירים מקושרים → קישור מכשיר');
        askedForQr = true;
      }
      await sleep(2000);
    }
    throw new Error('ווצאפ ווב לא נטען תוך 10 דקות (לא נסרק QR?)');
  }

  /** Switches to another chat or group (changed in the settings). */
  async setTarget(target) {
    this.setTargetOnly(target);
    await this.ensureReady();
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

module.exports = { WhatsAppWeb, normalizePhone, groupInviteCode };
