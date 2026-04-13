import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TIMEZONE = "Europe/Warsaw";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

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
  const [h, m] = time.split(":").map(Number);
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
    .filter(event => event.start?.dateTime && event.end?.dateTime)
    .map(event => ({
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

    const hasConflict = busyEvents.some(event =>
      overlaps(slotStart, slotEnd, event.start, event.end)
    );

    if (!hasConflict) {
      availableSlots.push(slotTime);
    }
  }

  return availableSlots;
}

app.get("/api/availability", async (req, res) => {
  try {
    const duration = Number(req.query.duration);

    if (!duration) {
      return res.status(400).json({
        ok: false,
        message: "Brak duration"
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
    console.error("Availability error:", error);
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

    if (!date || !duration) {
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
    console.error("Slots error:", error);
    return res.status(500).json({
      ok: false,
      message: "Nie udało się pobrać wolnych godzin"
    });
  }
});

app.post("/api/bookings", async (req, res) => {
  try {
    const { name, phone, service, price, duration, date, time } = req.body;

    if (!name || !phone || !service || !price || !duration || !date || !time) {
      return res.status(400).json({
        ok: false,
        message: "Brakuje wymaganych danych"
      });
    }

    const freshSlots = await getAvailableSlots(date, Number(duration));

    if (!freshSlots.includes(time)) {
      return res.status(409).json({
        ok: false,
        message: "Ten termin został już zajęty. Wybierz inny."
      });
    }

    const startDateTime = combineDateAndTime(date, time);
    const endDateTime = addMinutes(startDateTime, Number(duration));

    const event = {
      summary: `${service} — ${name}`,
      description:
        `Nowa rezerwacja\n` +
        `Imię: ${name}\n` +
        `Telefon: ${phone}\n` +
        `Usługa: ${service}\n` +
        `Cena: ${price} zł\n` +
        `Czas: ${duration} min\n` +
        `Data: ${date}\n` +
        `Godzina: ${time}`,
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

    return res.json({
      ok: true,
      message: "Rezerwacja została zapisana",
      eventId: createdEvent.data.id,
      eventLink: createdEvent.data.htmlLink
    });
  } catch (error) {
    console.error("Booking error:", error);
    return res.status(500).json({
      ok: false,
      message: "Nie udało się utworzyć rezerwacji"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
