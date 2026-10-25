import type { Alert, AreaWarning, SaintTask, VulnerableCategory } from '@monsoonwatch/shared';
import type { SaintUpdateResult } from '../api/client';

export const PICKUP_CATEGORY: Record<VulnerableCategory, string> = {
  bedridden: 'bedridden', disabled: 'disabled', elderly: 'elderly', noTransport: 'without transport',
};
export interface SaintContext {
  alerts: Map<string, Alert>;
  warnings: Map<string, AreaWarning>;
  villages: Map<string, string>;
  centres: Map<string, string>;
}
export const emptySaintContext = (): SaintContext => ({ alerts: new Map(), warnings: new Map(), villages: new Map(), centres: new Map() });

/** Display only: never rewrite the approved brief sent to WhatsApp. */
export function saintText(text: string, context: SaintContext): string {
  let value = text.replace(/Spoken versions \(WAV[^)]*\):[^\n]*(?= · Brief sent)|Spoken versions \(WAV[^)]*\):[^\n]*/gi, '').replace(/(?:https?:\/\/[^\s]*|\/api\/[^\s]*)\/audio\/[^\s,;)]+/gi, '')
    .replace(/https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/[^\s]+/gi, '[WhatsApp link]');
  const names = new Map([...context.villages, ...context.centres]);
  for (const alert of context.alerts.values()) names.set(alert._id, context.villages.get(alert.villageId) ?? 'approved alert');
  for (const warning of context.warnings.values()) names.set(warning._id, `${warning.district} district`);
  // Longest IDs first: alert IDs can contain village IDs.
  for (const [id, name] of [...names].sort((a, b) => b[0].length - a[0].length)) {
    if (id) value = value.split(id).join(name);
  }
  return value.replace(/osm-(?:node|way|relation)-\d+/gi, 'location unavailable')
    .replace(/\bnoTransport\b/g, PICKUP_CATEGORY.noTransport)
    .replace(/\bnull\b/g, 'not provided')
    // Phone-shaped strings (including international, spaced and bracketed forms).
    .replace(/(?:\+?\d[\d ().-]{6,}\d)/g, '[contact hidden]')
    .replace(/[ \t]{2,}/g, ' ').trim();
}

export function saintTaskDetail(task: SaintTask, context: SaintContext): string {
  if (task.type === 'send_alert') {
    if (task.target === 'area_warning') {
      const warning = context.warnings.get(task.alertId);
      if (warning) return saintText(`${warning.district} district · ${warning.villageIds.length} villages`, context);
    } else {
      const alert = context.alerts.get(task.alertId);
      const village = alert && context.villages.get(alert.villageId);
      const centre = alert && context.centres.get(alert.evacCentreId);
      if (alert && village && centre) {
        const groups = alert.pickups?.length ?? 0;
        return saintText(`${alert.level.toUpperCase()} ${alert.hazard} · ${village} → ${centre} · ${alert.people.toLocaleString('en-GB')} people · ${groups} pickup ${groups === 1 ? 'group' : 'groups'}`, context);
      }
    }
  }
  return saintText(task.detail, context);
}

export function saintTaskStatus(task: SaintTask, tasks: Iterable<SaintTask>): string {
  if (task.type === 'send_alert' && task.status === 'in_progress'
    && ![...tasks].some(t => t.alertId === task.alertId && t.type === 'log_checkin' && t.status === 'done')) {
    const date = new Date(task.ts);
    const sent = Number.isNaN(date.getTime()) ? '' : ` · sent ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    return `Waiting for the village head’s check-in${sent}`;
  }
  return task.status.replaceAll('_', ' ');
}

export function saintAppliedText(item: SaintUpdateResult['applied'][number], context: SaintContext): string {
  const centre = context.centres.get(item.centreId) ?? item.centre;
  return saintText(item.people === null ? `Acknowledged → ${centre}` : `${item.people} people ${item.status} → ${centre}`, context);
}
