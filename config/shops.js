// config/shops.js
const shops = {
  toh: {
    name: "TOH Motorbike Rental",
    sheetId: process.env.SHEET_ID, // existing TOH sheet, unchanged
  },
  // future shops get added here, e.g.:
  // "shop2": { name: "...", sheetId: "..." }
};

function getShop(shopId) {
  const shop = shops[shopId];
  if (!shop) throw new Error(`Unknown shop: ${shopId}`);
  return shop;
}

module.exports = { shops, getShop };
