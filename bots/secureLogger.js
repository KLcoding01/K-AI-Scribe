// bots/secureLogger.js
function safe(obj) {
  if (!obj) return undefined;
  
  return JSON.stringify(obj, (k, v) => {
    const key = k.toLowerCase();
    if (
        key.includes("name") ||
        key.includes("dob") ||
        key.includes("address") ||
        key.includes("phone") ||
        key.includes("email") ||
        key.includes("mrn") ||
        key.includes("insurance") ||
        key.includes("subjective") ||
        key.includes("note")
        ) {
          return "[REDACTED]";
        }
    return v;
  });
}

function log(event, meta = {}) {
  console.log(
              JSON.stringify({
                ts: new Date().toISOString(),
                event,
                meta: safe(meta),
              })
              );
}

function warn(event, meta = {}) {
  console.warn(
               JSON.stringify({
                 ts: new Date().toISOString(),
                 level: "WARN",
                 event,
                 meta: safe(meta),
               })
               );
}

function error(event, meta = {}) {
  console.error(
                JSON.stringify({
                  ts: new Date().toISOString(),
                  level: "ERROR",
                  event,
                  meta: safe(meta),
                })
                );
}

module.exports = { log, warn, error };
