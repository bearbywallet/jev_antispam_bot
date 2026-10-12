import type { Api } from "grammy";

const ADMIN_TTL_MS = 5 * 60 * 1_000;

type Entry = { isAdmin: boolean; expiresAt: number };
export type AdminSummary = { id: number; name: string; username?: string };

export class AdminCache {
  private readonly entries = new Map<string, Entry>();
  private readonly lists = new Map<number, { expiresAt: number; admins: AdminSummary[] }>();

  invalidate(chatId: number, userId: number): void {
    this.entries.delete(`${chatId}:${userId}`);
    // The affected user may be on (or joining) the cached admin list.
    const list = this.lists.get(chatId);
    if (list && list.admins.some((admin) => admin.id === userId)) this.lists.delete(chatId);
  }

  async isAdmin(api: Api, chatId: number, userId: number): Promise<boolean> {
    const key = `${chatId}:${userId}`;
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.isAdmin;

    const member = await api.getChatMember(chatId, userId);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    this.entries.set(key, { isAdmin, expiresAt: Date.now() + ADMIN_TTL_MS });
    return isAdmin;
  }

  /** Cached admin summaries (id, display name, @username) for impersonation screening. */
  async administrators(api: Api, chatId: number): Promise<AdminSummary[]> {
    const cached = this.lists.get(chatId);
    if (cached && cached.expiresAt > Date.now()) return cached.admins;

    const members = await api.getChatAdministrators(chatId);
    const admins = members
      .map((member) => ({
        id: member.user.id,
        name: [member.user.first_name, member.user.last_name].filter(Boolean).join(" ").trim(),
        ...(member.user.username ? { username: member.user.username } : {}),
      }))
      .filter((admin) => admin.name.length > 0);
    this.lists.set(chatId, { admins, expiresAt: Date.now() + ADMIN_TTL_MS });
    return admins;
  }
}
