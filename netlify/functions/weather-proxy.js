// Netlify Function: proxy seguro e restrito para dados meteorológicos Open-Meteo.
const ALLOWED_ENDPOINTS = {
  gfs: "https://api.open-meteo.com/v1/gfs",
  forecast: "https://api.open-meteo.com/v1/forecast"
};

const ALLOWED_HOURLY = new Set([
  "cape", "convective_inhibition", "temperature_2m", "dew_point_2m",
  "wind_speed_10m", "wind_direction_10m",
  "wind_speed_925hPa", "wind_direction_925hPa",
  "wind_speed_500hPa", "wind_direction_500hPa",
  "showers", "weather_code", "precipitation"
]);

exports.handler = async function (event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: { "Allow": "GET" }, body: "Method not allowed" };
  }

  try {
    const input = event.queryStringParameters || {};
    const endpoint = ALLOWED_ENDPOINTS[input.endpoint];
    if (!endpoint) {
      return { statusCode: 400, body: JSON.stringify({ error: "Endpoint meteorológico inválido." }) };
    }

    const latitudes = String(input.latitude || "").split(",");
    const longitudes = String(input.longitude || "").split(",");
    if (!latitudes.length || latitudes.length !== longitudes.length || latitudes.length > 50) {
      return { statusCode: 400, body: JSON.stringify({ error: "Coordenadas inválidas." }) };
    }
    const validCoordinate = (value, min, max) =>
      value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;
    if (!latitudes.every(v => validCoordinate(v, -90, 90)) ||
        !longitudes.every(v => validCoordinate(v, -180, 180))) {
      return { statusCode: 400, body: JSON.stringify({ error: "Latitude ou longitude fora do intervalo válido." }) };
    }

    const hourly = String(input.hourly || "").split(",");
    if (!hourly.length || hourly.some(v => !ALLOWED_HOURLY.has(v))) {
      return { statusCode: 400, body: JSON.stringify({ error: "Variáveis meteorológicas não permitidas." }) };
    }

    const params = new URLSearchParams();
    params.set("latitude", latitudes.join(","));
    params.set("longitude", longitudes.join(","));
    params.set("hourly", hourly.join(","));

    const forecastDays = Number(input.forecast_days || 2);
    if (!Number.isInteger(forecastDays) || forecastDays < 1 || forecastDays > 3) {
      return { statusCode: 400, body: JSON.stringify({ error: "Período de previsão inválido." }) };
    }
    params.set("forecast_days", String(forecastDays));

    const timezone = input.timezone === "auto" ? "auto" : "America/Sao_Paulo";
    params.set("timezone", timezone);

    if (input.wind_speed_unit === "kmh") params.set("wind_speed_unit", "kmh");
    if (input.endpoint === "forecast" && input.models === "gfs_seamless") {
      params.set("models", "gfs_seamless");
    }

    const upstream = await fetch(`${endpoint}?${params.toString()}`, {
      headers: { "Accept": "application/json" }
    });

    const body = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "Access-Control-Allow-Origin": "*"
      },
      body
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        error: "Falha ao consultar o serviço meteorológico.",
        detail: String(error && error.message ? error.message : error)
      })
    };
  }
};
