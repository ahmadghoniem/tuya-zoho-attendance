// Lock credential -> Zoho employee ID, one table per lock.
// Copy this file to mapping.js (ignored by git) and fill in your own locks.
//
// Slot numbers belong to one lock: face|39 on one lock and face|39 on another
// are usually different people. One person can own several credentials.
// The lock's open-logs in the Tuya app name the lock user behind each slot.
//
// `ignore` lists credentials of people who have no Zoho People record, so
// their unlocks stay distinguishable from a credential nobody has identified.
// Anything in neither table is logged as UNMAPPED.

export const LOCKS = [
  {
    name: "front office",
    id: "TUYA_DEVICE_ID_1",
    people: {
      "unlock_face|10": "4",         // lock user name -> Zoho employee name
      "unlock_fingerprint|1": "1",
      "unlock_password|33": "15",
    },
    ignore: new Set([
      "unlock_face|20",        // cleaner, not in Zoho
    ]),
  },
  {
    name: "back office",
    id: "TUYA_DEVICE_ID_2",
    people: {
      "unlock_face|1": "1",          // same person as fingerprint|1 above
    },
    ignore: new Set([]),
  },
];
