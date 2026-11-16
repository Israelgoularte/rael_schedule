import { failure } from './security.mjs';

export const communitySeats = 2;

export function createProfessionalSeats(current, limitMessage) {
  async function assertSeats(tx, settings, professionals, publishing = false) {
    const active = professionals.filter(person => person.active);
    const { seats } = await current(tx);
    if (active.length <= seats) return;
    const previouslyActive = new Set(settings.draft.professionals.filter(person => person.active).map(person => person.id));
    // Existing installations can edit or deactivate profiles while reducing an
    // oversized team. Any new activation and publication must fit the plan.
    if (publishing || active.some(person => !previouslyActive.has(person.id))) {
      throw failure(422, limitMessage(seats));
    }
  }

  async function bookable(conn, settings) {
    const active = new Set(settings.draft.professionals.filter(person => person.active).map(person => person.id));
    const { seats } = await current(conn);
    const published = settings.published?.professionals ?? [];
    return new Set(published.filter(person => active.has(person.id)).slice(0, seats).map(person => person.id));
  }

  return { current, assertSeats, bookable };
}

export const communityProfessionalSeats = createProfessionalSeats(
  () => ({ plan: 'community', seats: communitySeats }),
  seats => `O plano Community permite até ${seats} profissionais ativos. Inative um profissional para liberar uma vaga.`
);
