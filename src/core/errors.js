// 领域错误：携带业务错误码与 HTTP 状态，路由层统一转成错误响应。

export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function notFound(what, id) {
  return new DomainError("not_found", `${what}不存在：${id}`, { status: 404 });
}

export function validation(problems) {
  return new DomainError("validation_failed", `字段校验未通过：${problems.join("、")}`, {
    status: 400,
    details: { problems },
  });
}

export function forbidden(message, details) {
  return new DomainError("forbidden", message, { status: 403, details });
}
