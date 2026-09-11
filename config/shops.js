const shops = {
  toh: {
    name: "TOH Motorbike Rental",
    sheetId: process.env.SHEET_ID,
    fleetSheetId: process.env.FLEET_SHEET_ID || '1XvSdL_oQvEZccji43kg-2C7BQgZLXi3Don2y-lZicuY',
  },
};

function getShop(shopId) {
  const shop = shops[shopId];
  if (!shop) throw new Error(`Unknown shop: ${shopId}`);
  return shop;
}

module.exports = { shops, getShop };
