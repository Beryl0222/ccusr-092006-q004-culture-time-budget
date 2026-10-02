// 会员体系：成年账户与青少年子账号、家庭挂接、设备登记。
// 关键约束：节律控制作用在“会员”而不是“App 实例”上，
// 青少年在一台新设备登录不能绕开限制——设备须经监护人认可。

export class Members {
  constructor(store) {
    this.store = store;
    this.members = new Map(); // memberId -> {id, is_teen, guardian_id, time_zone, created_at}
    this.devices = new Map(); // memberId -> [{device_id, approved, approved_by, name}]
    store.subscribe((e) => this._apply(e));
    for (const e of store.all()) this._apply(e);
  }

  _apply(event) {
    if (event.kind === "MEMBER_REGISTERED") {
      this.members.set(event.subject_id, {
        id: event.subject_id,
        is_teen: Boolean(event.payload.is_teen),
        guardian_id: event.payload.guardian_id ?? null,
        time_zone: event.payload.time_zone ?? "Asia/Shanghai",
        created_at: event.occurred_at,
      });
    } else if (event.kind === "TEEN_LINKED") {
      const m = this.members.get(event.payload.teen_id);
      if (m) m.guardian_id = event.payload.guardian_id;
    } else if (event.kind === "DEVICE_REGISTERED") {
      const list = this.devices.get(event.subject_id) ?? [];
      list.push({
        device_id: event.payload.device_id,
        name: event.payload.name ?? "",
        approved: Boolean(event.payload.approved),
        approved_by: event.payload.approved_by ?? null,
        registered_at: event.occurred_at,
      });
      this.devices.set(event.subject_id, list);
    }
  }

  register(memberId, { is_teen = false, guardian_id = null, time_zone = "Asia/Shanghai", at = null } = {}) {
    const { event } = this.store.append(
      "MEMBER_REGISTERED",
      memberId,
      { is_teen, guardian_id, time_zone },
      { occurredAt: at },
    );
    return event;
  }

  linkTeen(teenId, guardianId, { at = null } = {}) {
    const { event } = this.store.append(
      "TEEN_LINKED",
      guardianId,
      { teen_id: teenId, guardian_id: guardianId },
      { occurredAt: at },
    );
    return event;
  }

  registerDevice(memberId, deviceId, { name = "", approved = true, approvedBy = null, at = null } = {}) {
    const { event } = this.store.append(
      "DEVICE_REGISTERED",
      memberId,
      { device_id: deviceId, name, approved, approved_by: approvedBy },
      { occurredAt: at },
    );
    return event;
  }

  get(memberId) {
    return this.members.get(memberId) ?? null;
  }

  device(memberId, deviceId) {
    return (this.devices.get(memberId) ?? []).find((d) => d.device_id === deviceId) ?? null;
  }

  // 青少年使用未被监护人认可的设备即视为绕行尝试。
  isDeviceAllowed(memberId, deviceId) {
    const m = this.get(memberId);
    if (!m) return { ok: false, reason: "UNKNOWN_MEMBER" };
    const device = this.device(memberId, deviceId);
    if (!device) return { ok: false, reason: m.is_teen ? "TEEN_UNKNOWN_DEVICE" : "ADULT_UNKNOWN_DEVICE" };
    if (m.is_teen && !device.approved) return { ok: false, reason: "TEEN_DEVICE_NOT_APPROVED" };
    return { ok: true, reason: null };
  }
}
