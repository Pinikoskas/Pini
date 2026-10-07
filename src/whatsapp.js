// Builds the WhatsApp alert for a found post, and checks the WhatsApp settings.

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

function checkWhatsAppSettings(settings) {
  if (!settings || !settings.phone) return 'חסר מספר טלפון ב-config.yaml (whatsapp.phone).';
  return null;
}

module.exports = { formatPostMessage, checkWhatsAppSettings };
