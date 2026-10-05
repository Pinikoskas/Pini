// Send WhatsApp messages to yourself through CallMeBot (free, personal use).
// Setup: https://www.callmebot.com/blog/free-api-whatsapp-messages/

const MAX_TEXT = 1200;

function formatPostMessage(post, ageDesc) {
  const text = post.text.replace(/\s+/g, ' ').trim();
  const preview = text.length > 400 ? text.slice(0, 400) + '…' : text;
  const lines = [
    "🎧 *נמצא פוסט: מחפשים דיג'יי!*",
    `👤 ${post.authorName || 'לא ידוע'}`,
    `🕒 עלה: ${ageDesc}`,
    '',
    `📝 ${preview}`,
    '',
  ];
  if (post.url) lines.push(`🔗 ${post.url}`);
  if (post.authorUrl) lines.push(`פרופיל: ${post.authorUrl}`);
  return lines.join('\n').trim();
}

async function sendWhatsApp(settings, text) {
  const phone = String(settings.phone || '').replace(/[^\d+]/g, '');
  const url =
    'https://api.callmebot.com/whatsapp.php' +
    `?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(text.slice(0, MAX_TEXT))}` +
    `&apikey=${encodeURIComponent(String(settings.apikey || ''))}`;
  const res = await fetch(url);
  const body = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!res.ok || /error|invalid|not (?:active|allowed)/i.test(body)) {
    throw new Error(`CallMeBot ${res.status}: ${body.slice(0, 200)}`);
  }
}

function checkWhatsAppSettings(settings) {
  if (!settings || !settings.enabled) return null;
  if (!settings.phone) return 'חסר מספר טלפון ב-config.yaml (whatsapp.phone).';
  if ((settings.method || 'web') === 'callmebot' && !settings.apikey) {
    return (
      'חסרים פרטי ווצאפ ב-config.yaml (whatsapp.phone / whatsapp.apikey).\n' +
      'הוראות קבלת apikey: https://www.callmebot.com/blog/free-api-whatsapp-messages/'
    );
  }
  return null;
}

module.exports = { formatPostMessage, sendWhatsApp, checkWhatsAppSettings };
