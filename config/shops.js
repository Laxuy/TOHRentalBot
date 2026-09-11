const shops = {
  toh: {
    name: "TOH Motorbike Rental",
    sheetId: process.env.SHEET_ID,           // bookings sheet
    fleetSheetId: process.env.FLEET_SHEET_ID, // fleet tracker sheet
  },
  // future shops get added here, e.g.:
  // "shop2": { name: "...", sheetId: "...", fleetSheetId: "..." }
};

function getShop(shopId) {
  const shop = shops[shopId];
  if (!shop) throw new Error(`Unknown shop: ${shopId}`);
  return shop;
}

module.exports = { shops, getShop };
