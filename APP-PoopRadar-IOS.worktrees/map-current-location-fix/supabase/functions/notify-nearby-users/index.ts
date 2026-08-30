// Supabase Edge Function: notify-nearby-users
// Wird per Database Webhook bei jedem INSERT in "reports" aufgerufen.
// Sendet Expo-Push-Benachrichtigungen an alle User mit gespeichertem
// Push-Token, deren letzte bekannte Position < 500m vom neuen Report liegt.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EXPO_PUSH_API = 'https://exp.host/--/api/v2/push/send';

function getNormalizedType(rawType: string): string {
  if (!rawType) return 'POOP';
  if (rawType === 'S' || rawType === 'M' || rawType === 'L') return 'POOP';
  if (rawType === 'POOP' || rawType === 'BIN_BAGS' || rawType === 'POISON') return rawType;
  return 'POOP';
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

serve(async (req: Request) => {
  try {
    const body = await req.json();

    // Supabase Database Webhook sendet { type, table, schema, record, old_record }
    const report = body.record ?? body.new ?? body;

    if (!report?.latitude || !report?.longitude) {
      return new Response('No location in report', { status: 200 });
    }

    const normalizedType = getNormalizedType(report.size);

    // Tüten-Reports: keine Benachrichtigung
    if (normalizedType === 'BIN_BAGS') {
      return new Response('BIN_BAGS – kein Alarm', { status: 200 });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Alle Profile mit Push-Token und gespeichertem Standort laden
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, expo_push_token, last_lat, last_lng')
      .not('expo_push_token', 'is', null)
      .not('last_lat', 'is', null)
      .not('last_lng', 'is', null);

    if (profilesError) {
      console.error('Fehler beim Laden der Profile:', profilesError);
      return new Response('DB-Fehler', { status: 500 });
    }

    if (!profiles?.length) {
      return new Response('Keine Profile mit Push-Token gefunden', { status: 200 });
    }

    const reporterUserId = report.user_id;
    const reportLat = parseFloat(report.latitude);
    const reportLng = parseFloat(report.longitude);
    const isPoisonAlert = normalizedType === 'POISON';

    const messages: object[] = [];

    for (const profile of profiles) {
      // Den Melder selbst nicht benachrichtigen
      if (profile.id === reporterUserId) continue;

      const distance = calculateDistance(
        parseFloat(profile.last_lat),
        parseFloat(profile.last_lng),
        reportLat,
        reportLng,
      );

      // Haufen: nur innerhalb 500m. Giftköder: immer (Sicherheit)
      if (normalizedType === 'POOP' && distance > 500) continue;

      const distanceText =
        distance < 100 ? 'ganz nah' : `${Math.round(distance / 10) * 10}m`;

      messages.push({
        to: profile.expo_push_token,
        sound: 'default',
        channelId: 'poop-alerts',
        title: isPoisonAlert ? '⚠️ Giftköder Warnung!' : '💩 Haufen in der Nähe!',
        body: isPoisonAlert
          ? `⚠️ Giftköder gemeldet in ${report.city ?? 'deiner Nähe'} (${distanceText} entfernt)`
          : `💩 Haufen ${distanceText} entfernt in ${report.city ?? 'deiner Nähe'}`,
        data: { reportId: report.id, type: normalizedType },
      });
    }

    if (!messages.length) {
      return new Response('Keine User in der Nähe', { status: 200 });
    }

    // Expo Push API erlaubt max 100 Nachrichten pro Request
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const response = await fetch(EXPO_PUSH_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        const errBody = await response.text();
        console.error('Expo Push Fehler:', errBody);
      }
    }

    console.log(`Push gesendet an ${messages.length} User(s)`);
    return new Response(JSON.stringify({ sent: messages.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Unerwarteter Fehler:', err);
    return new Response('Interner Fehler', { status: 500 });
  }
});
