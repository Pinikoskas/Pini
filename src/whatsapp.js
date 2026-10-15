// Builds the WhatsApp alert for a found post, and checks the WhatsApp settings.

function formatPostMessage(post, ageDesc) {
  const text = post.text.replace(/\s+/g, ' ').trim();
  const preview = text.length > 400 ? text.slice(0, 400) + '…' : text;
  const lines = [
    "🎧 *נמצא פוסט: מחפשים דיג'יי!*",
    `👤 ${post.authorName || 'לא ידוע'}`,
    ...(post.groupName ? [`👥 בקבוצה: ${post.groupName}`] : []),
    `🕒 עלה: ${ageDesc}`,
    '',
    `📝 ${preview}`,
    '',
  ];
  if (post.url) lines.push(`🔗 ${post.url}`);
  else if (post.groupLink) lines.push(`🔗 הקבוצה (לא הצלחתי לקבל קישור לפוסט עצמו): ${post.groupLink}`);
  if (post.authorUrl) lines.push(`פרופיל: ${post.authorUrl}`);
  return lines.join('\n').trim();
}

function checkWhatsAppSettings(settings) {
  if (!settings || (!settings.phone && !settings.group_name)) return 'חסר מספר טלפון או שם של קבוצת ווצאפ בהגדרות.';
  if (settings.group_link && !settings.group_name) return 'מלא גם את שם קבוצת הווצאפ (בדיוק כמו שהוא מופיע בווצאפ).';
  return null;
}

module.exports = { formatPostMessage, checkWhatsAppSettings };
