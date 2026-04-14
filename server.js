import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TIMEZONE = "Europe/Warsaw";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const requiredEnv = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN"
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error("Missing required env variables:", missingEnv.join(", "));
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({
  version: "v3",
  auth: oauth2Client
});

const WORKING_HOURS = {
  start: "10:00",
  end: "18:00",
  slotStepMinutes: 30
};

function parseTimeToMinutes(time) {
  if (!time || !time.includes(":")) return NaN;
  const [h, m] = time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return NaN;
  return h * 60 + m;
}

function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function combineDateAndTime(date, time) {
  return new Date(`${date}T${time}:00+02:00`);
}

function addMinutes(dateObj, minutes) {
  return new Date(dateObj.getTime() + minutes * 60000);
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function isValidDateString(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function isValidTimeString(time) {
  return /^\d{2}:\d{2}$/.test(time);
}

function normalizePrice(price) {
  if (price === undefined || price === null || price === "") return "";
  return String(price).trim().replace(/\s*zł\s*$/i, "");
}

async function getBusyEvents(date) {
  const timeMin = new Date(`${date}T00:00:00+02:00`).toISOString();
  const timeMax = new Date(`${date}T23:59:59+02:00`).toISOString();

  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime"
  });

  return (response.data.items || [])
    .filter((event) => event.start?.dateTime && event.end?.dateTime)
    .map((event) => ({
      start: new Date(event.start.dateTime),
      end: new Date(event.end.dateTime)
    }));
}

async function getAvailableSlots(date, duration) {
  const busyEvents = await getBusyEvents(date);

  const startMinutes = parseTimeToMinutes(WORKING_HOURS.start);
  const endMinutes = parseTimeToMinutes(WORKING_HOURS.end);
  const step = WORKING_HOURS.slotStepMinutes;

  const availableSlots = [];

  for (let current = startMinutes; current + duration <= endMinutes; current += step) {
    const slotTime = minutesToTime(current);
    const slotStart = combineDateAndTime(date, slotTime);
    const slotEnd = addMinutes(slotStart, duration);

    const hasConflict = busyEvents.some((event) =>
      overlaps(slotStart, slotEnd, event.start, event.end)
    );

    if (!hasConflict) {
      availableSlots.push(slotTime);
    }
  }

  return availableSlots;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend-index.html"));
});

app.get("/api/availability", async (req, res) => {
  try {
    const duration = Number(req.query.duration);

    if (!duration || duration <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Brak poprawnego duration"
      });
    }

    const today = new Date();
    const availableDates = [];

    for (let i = 0; i < 21; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);

      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const dateStr = `${year}-${month}-${day}`;

      const slots = await getAvailableSlots(dateStr, duration);

      if (slots.length > 0) {
        availableDates.push(dateStr);
      }
    }

    return res.json({
      ok: true,
      availableDates
    });
  } catch (error) {
    console.error("Availability error:", error?.response?.data || error.message || error);
    return res.status(500).json({
      ok: false,
      message: "Nie udało się pobrać dostępnych dat"
    });
  }
});

app.get("/api/availability/slots", async (req, res) => {
  try {
    const { date } = req.query;
    const duration = Number(req.query.duration);

    if (!date || !isValidDateString(date) || !duration || duration <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Brakuje date lub duration"
      });
    }

    const availableSlots = await getAvailableSlots(date, duration);

    return res.json({
      ok: true,
      availableSlots
    });
  } catch (error) {
    console.error("Slots error:", error?.response?.data || error.message || error);
    return res.status(500).json({
      ok: false,
      message: "Nie udało się pobrać wolnych godzin"
    });
  }
});

app.post("/api/bookings", async (req, res) => {
  try {
    const { name, phone, service, price, duration, date, time, notes } = req.body;

    if (!name || !phone || !service || !price || !duration || !date || !time) {
      return res.status(400).json({
        ok: false,
        message: "Brakuje wymaganych danych"
      });
    }

    if (!isValidDateString(date) || !isValidTimeString(time)) {
      return res.status(400).json({
        ok: false,
        message: "Niepoprawna data lub godzina"
      });
    }

    const numericDuration = Number(duration);
    if (!numericDuration || numericDuration <= 0) {
      return res.status(400).json({
        ok: false,
        message: "Niepoprawny czas usługi"
      });
    }

    const freshSlots = await getAvailableSlots(date, numericDuration);

    if (!freshSlots.includes(time)) {
      return res.status(409).json({
        ok: false,
        message: "Ten termin został już zajęty. Wybierz inny."
      });
    }

    const startDateTime = combineDateAndTime(date, time);
    const endDateTime = addMinutes(startDateTime, numericDuration);

    if (Number.isNaN(startDateTime.getTime()) || Number.isNaN(endDateTime.getTime())) {
      return res.status(400).json({
        ok: false,
        message: "Nie udało się przetworzyć daty lub godziny"
      });
    }

    const cleanedPrice = normalizePrice(price);

    const event = {
      summary: `${service} — ${name}`,
      description: [
        "Nowa rezerwacja",
        `Imię: ${name}`,
        `Telefon: ${phone}`,
        `Usługa: ${service}`,
        cleanedPrice ? `Cena: ${cleanedPrice} zł` : null,
        `Czas: ${numericDuration} min`,
        `Data: ${date}`,
        `Godzina: ${time}`,
        notes ? `Uwagi: ${notes}` : null
      ]
        .filter(Boolean)
        .join("\n"),
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: TIMEZONE
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: TIMEZONE
      }
    };

    const createdEvent = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: event
    });

    return res.status(200).json({
      ok: true,
      message: "Rezerwacja została zapisana",
      eventId: createdEvent.data.id,
      eventLink: createdEvent.data.htmlLink
    });
  } catch (error) {
    console.error("Booking error:", error?.response?.data || error.message || error);
    return res.status(500).json({
      ok: false,
      message: "Nie udało się utworzyć rezerwacji"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server started on port ${PORT}`);
});
