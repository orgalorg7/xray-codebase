function pad(value, width) {
  return String(value).padStart(width, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

module.exports = { formatDate, pad };
