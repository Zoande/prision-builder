# Prison Builder — Expansion Bible

Content plan: ~40 rooms, ~200 objects, 8 new needs, staff systems.

**Cost legend** — how much engineering each item actually costs:

| Chip | Meaning |
| --- | --- |
| **[data]** | A row in a table. No new logic. |
| **[mesh]** | A table row plus a box-assembly mesh. |
| **[sys]** | Needs new sim logic. |
| **[BIG]** | A feature in its own right. |

---

## The thesis: content is cheap, content *plumbing* is not

Today one object costs code in five places: an `Obj` enum entry, a mesh, membership in the
`SINGLE` set, an editor palette item, and an `apply()` switch arm. Every *usable* object also
costs a hard-coded memory `Set` on `Agent` and a bespoke state in the behaviour machine.

At 20 objects that is fine. At 200 it collapses.

So: **land the four unlock changes first** (Part 1). After them a new object is a data row plus
a box mesh, and a new need is a data row. Everything below Part 1 then becomes authoring work,
not engineering work.

---

## Part 1 — The unlock layer

Four changes. The only place real engineering is required.

### 01. One object table (`ObjDef`)

Move every per-object fact out of the five switch statements into a single registry: id, name,
footprint, walkable, blocks-sight, category, swatch, cost, ambience, needs served, room
requirements satisfied. The editor palette, `canObj`, `passable`, `furnitureInstances` and room
validation all read from it. Turns "add an object" from a five-file edit into a one-line edit.

### 02. Rectangular footprints

Today: single tiles, a hard-coded 2-tile bed, and linear spans for benches. Nothing can be 2x2.
Generalise all three into one `Piece { kind, x, z, orient, w, d }` list — bed becomes a 2x1
piece, bench a 4x1 piece. Unlocks pool tables, boxing rings, bunk beds, generators, ovens, and
every "large" tier in the catalog.

### 03. Use-slots

Each object declares where an agent stands to use it, the pose (stand / sit / lie / lean), how
long a use lasts, how many can use it at once, and which needs it refills and how fast. Using a
bookshelf, treadmill, TV or phone booth then runs through *one* generic `using` state instead of
one bespoke state per object. This is what makes "yard objects that fill new needs" an authoring
task.

### 04. Generic prisoner memory

Replace the six hard-coded memory sets (`beds`, `tables`, `benches`, `toilets`, `showers`,
`servings`) with one `Map<kind, Set<tile>>`. Prisoners then remember any object type for free,
and "what do I know that fills this need?" becomes a single lookup driven by `ObjDef`.

**Why this order:** each is independently shippable and each makes the next smaller. After 01+02
you can add every cosmetic and every big-footprint object. After 03+04, every *functional*
object and every new need becomes data.

---

## Part 2 — Needs

Existing five: food, sleep, outdoors, comfort, hygiene. The weighted scoring loop in `decide()`
already handles competition between them, so each new need is a rate, a weight, and a set of
objects that serve it.

| Need | Filled by | What makes it more than a bar | Cost |
| --- | --- | --- | --- |
| **Recreation** | TV, pool table, arcade, board games, radio, dartboard, chess table | The anchor need for every rec object. Starved recreation is the largest driver of riot pressure. | [data] |
| **Exercise** | Weights, treadmill, punching bag, pull-up bar, court, jogging track | Raises **Strength**, and Strength cuts `CLIMB_TIME`. A good gym produces better fence-climbers. | [sys] |
| **Bladder** | Toilets (already exist) | Cheapest new need in the game — the object already exists. Failing it dumps hygiene and comfort and leaves a mess for a janitor. | [data] |
| **Privacy** | Own cell, cell door shut, solitary | Drains with the number of prisoners sharing a room. Makes dormitories a real trade-off against cells, not just cheaper. | [sys] |
| **Family** | Phone booth, visitation booth, mail room | Decays slowly; low Family feeds `escapeDesire` directly. | [sys] |
| **Craving** | Contraband only: cigarettes, booze, drugs | Cannot be satisfied legally. Creates the demand side of a smuggling economy and pushes prisoners into the existing `risk` machinery. | [BIG] |
| **Spirituality** | Chapel, pew, prayer mat, chaplain | Slow decay, deep refill. Cheap calm — the budget answer to unrest. | [data] |
| **Safety** | Guard presence, cameras, being in your cell | Drains near unsupervised crowds and violent inmates. Prerequisite for any violence/gang layer. | [BIG] |

### Prisoner stats — the layer that makes enrichment a real decision

Needs decay. *Stats* accumulate, and they stop the library and gym from being pure goodwill
purchases.

| Stat | Raised by | Effect |
| --- | --- | --- |
| **Strength** | Gym, yard equipment, workshop labour | Faster fence climbing, wins fights, digs faster |
| **Intelligence** | Library, classroom, chess | Less tunnel drift, better escape plans, spots guard patterns |
| **Reform** | Chapel, education, work, family contact | Suppresses escape desire; gates parole and release |
| **Health** | Infirmary, food quality, exercise | Movement speed; zero = death |
| **Notoriety** | Escapes attempted, fights won, contraband held | Sets required security wing; scares other prisoners' Safety |

> **The best hook in the codebase.** `TUNNEL_DRIFT = 0.16` is the heading error a digger
> accumulates per tile — why tunnellers surface somewhere they didn't intend. Make drift a
> function of **Intelligence**, and give the library the job of raising it.
>
> Now the library is a genuine dilemma. Educated prisoners have lower `escapeDesire` — but the
> ones who *do* run dig straight and come up exactly where they meant to. The gym is the same
> shape: fitter prisoners are calmer, and they climb your fences in half the time. **Every
> enrichment building lowers the odds of an escape attempt and raises the quality of the attempts
> you get.** Real strategic tension, for the price of two multipliers on variables that already
> exist.

---

## Part 3 — Rooms

Room definitions are already data — a min-square and a required-object list in `roomIssue()`.
Each room below is that plus a name. The *objects* are the work; the rooms are nearly free.

### Prisoner rooms

| Room | Min | Requires | Serves | Cost |
| --- | --- | --- | --- | --- |
| Library | 5x5 | Bookshelf, reading desk | Recreation, Intelligence | [mesh] |
| Gym | 5x5 | Weight bench, exercise mat | Exercise, Strength | [mesh] |
| Common Room | 5x5 | TV, sofa | Recreation, Comfort | [mesh] |
| Chapel | 5x5 | Altar, pew | Spirituality, Reform | [mesh] |
| Classroom | 5x5 | Whiteboard, school desk, teacher | Intelligence, Reform | [sys] |
| Visitation | 5x5 | Visitor booth, guard desk | Family — and a contraband route | [BIG] |
| Phone Bank | 2x2 | Phone booth | Family, cheaply | [mesh] |
| Infirmary | 5x5 | Medical bed, medicine cabinet, doctor | Health | [sys] |
| Workshop | 7x7 | Workbench, saw, foreman | Money, Reform — and tools that cut fences | [BIG] |
| Laundry | 5x5 | Washing machine, dryer | Hygiene, prisoner jobs | [sys] |
| Kitchen Garden | 6x6 | Planter bed, tool shed | Outdoors, food — and shovels | [sys] |
| Sports Court | 8x8 | Hoop or goal | Exercise, Recreation, Outdoors | [mesh] |
| Barbershop | 3x3 | Barber chair, mirror | Hygiene, Comfort — and scissors | [mesh] |
| Music Room | 4x4 | Instrument | Recreation | [mesh] |
| Art Room | 4x4 | Easel | Recreation, Reform | [mesh] |
| Solitary | 1x2 | Bed, solitary door | Punishment — wrecks every need but Safety | [sys] |
| Holding Cell | 3x3 | Bench, jail door | Where `cuffed` intakes actually wait | [data] |
| Reception | 5x5 | Search table, uniform rack | Intake processing, first search | [sys] |
| Mail Room | 4x4 | Sorting desk, mail crate | Family — and a contraband route | [sys] |
| Parole Room | 4x4 | Parole desk, chairs | Release — the win condition | [BIG] |

> **Holding cell is free content.** Agents already spawn with `cuffed: true` and wait for a cell
> assignment — they just wait wherever they happen to stand. Give that state a *room* and you've
> added a building the player must plan for, with no new behaviour at all.

### Staff rooms

| Room | Min | Requires | Serves | Cost |
| --- | --- | --- | --- | --- |
| Staff Room | 4x4 | Sofa, coffee machine | Off-duty staff rest | [sys] |
| Staff Canteen | 5x5 | Staff table, counter | Staff hunger | [data] |
| Locker Room | 4x4 | Lockers, bench | Shift change, equipment | [mesh] |
| Security Room | 4x4 | CCTV monitors, door desk | Camera coverage, remote doors | [BIG] |
| Warden's Office | 4x4 | Desk, filing cabinet | Policy, unlocks, reports | [sys] |
| Armoury | 3x3 | Weapon rack | Riot gear, tazers | [sys] |
| Maintenance | 4x4 | Tool rack, parts crate | Where workmen idle between repairs | [data] |
| Kennel | 4x4 | Dog bed, handler | Sniffer dogs — contraband and tunnels | [BIG] |
| Watchtower | 2x2 | Tower, guard post | Elevated vision over the yard | [sys] |
| Offices | 4x4 | Desk, computer | Admin staff, bureaucracy | [mesh] |

### Logistics & utility

| Room | Min | Requires | Serves | Cost |
| --- | --- | --- | --- | --- |
| Storage | 5x5 | Shelving rack | Where deliveries land | [sys] |
| Delivery Yard | 6x6 | Loading pallet, gate | Goods in — and contraband in | [BIG] |
| Power Room | 4x4 | Generator, fuse box | Lights and doors need power | [BIG] |
| Boiler Room | 4x4 | Boiler, water pump | Hot water for showers | [sys] |
| Sally Port | 2x4 | Two gates | Only one gate opens at a time | [sys] |
| Morgue | 3x3 | Mortuary slab | Consequences | [mesh] |

---

## Part 4 — Object catalog

Footprints assume change 02 has landed. "Tier" is the small/large pattern: same use-slot,
different footprint, capacity and fill rate — so a big bookshelf is *data*, not a second object.

### Library

| Object | Size | Effect |
| --- | --- | --- |
| Small Bookshelf | 1x1 | Recreation + Intelligence, slow. Fits a cell — the cell-legal tier. |
| Large Bookshelf | 2x1 | Same use, faster fill, 2 readers. The library tier. |
| Tall Bookshelf | 2x1 | Highest Intelligence rate; **blocks sight** — makes libraries hard to supervise. |
| Reading Desk | 2x1 | Sit + read. Pairs with a shelf. |
| Wooden Table | 2x1 | Cosmetic. High ambience. Warm counterpart to the steel canteen table. |
| Wooden Table, large | 2x2 | Cosmetic, higher ambience. |
| Reading Chair | 1x1 | Sit. Comfort. |
| Armchair | 1x1 | Sit. More comfort, more ambience. |
| Librarian's Desk | 2x1 | Staffed post; a manned library fills faster. |
| Card Catalogue | 1x1 | Cosmetic. |
| Magazine Rack | 1x1 | Recreation, small. |
| Study Carrel | 1x1 | Sit, private. Intelligence + a little Privacy. |
| Globe / Reading Lamp / Rug | 1x1 | Cosmetic. Ambience. |

### Yard

| Object | Size | Effect |
| --- | --- | --- |
| Basketball Hoop | 1x1 | Exercise + Recreation. Wants a painted court to matter. |
| Football Goal | 3x1 | Exercise + Recreation, group use. |
| Pull-up Bar | 2x1 | Exercise, Strength. The cheapest gym you can build. |
| Parallel Bars / Dip Station | 2x1 | Exercise, Strength. |
| Outdoor Weight Bench | 2x1 | Exercise, heavy Strength. |
| Punching Bag | 1x1 | Exercise; vents anger — reduces riot pressure. |
| Boxing Ring | 3x3 | Exercise, Recreation, spectators. Also where fights happen. |
| Jogging Track | floor | A *floor material*, not an object. Walk it to fill Exercise. |
| Picnic Table | 2x2 | Wooden. Sit, eat outdoors, Comfort + ambience. |
| Park Bench | 2x1 | Sit. Comfort + Outdoors. |
| Chess Table | 1x1 | Two seats. Recreation + Intelligence. Concrete, permanent. |
| Bleachers | 3x1 | Sit and watch. Comfort. |
| Drinking Fountain | 1x1 | Small comfort. Needs water. |
| Tree / Shrub / Flower Bed | 1x1 | Cosmetic. Big ambience outdoors. Trees block sight. |
| Canopy Shelter | 2x2 | Cosmetic; roofed but still counts as outdoors. |
| Smoking Area / Ashtray | 1x1 | The only *legal* Craving outlet — a policy choice. |
| Trash Can | 1x1 | Cosmetic. Janitors empty it; full ones drop ambience. |
| Watchtower | 2x2 | Elevated guard post; long vision cone over the yard. |

### Cell & dormitory

| Object | Size | Effect |
| --- | --- | --- |
| Bunk Bed | 2x1 | Two sleepers in one bed's footprint. Doubles capacity, halves Privacy. |
| Comfy Bed | 2x1 | Faster sleep refill, high ambience. A reward tier. |
| Small Bookshelf | 1x1 | The cell-legal enrichment object. |
| Small Desk + Stool | 1x1 | Sit. Comfort, a little Intelligence. |
| Footlocker | 1x1 | Contraband stash. Shakedowns search it first. |
| Cell Sink | 1x1 | Small hygiene. Needs water. |
| Mirror | wall | Comfort. Breaks into a shiv. |
| Radio / Small TV | 1x1 | Recreation without leaving the cell — quiets lockup hours. |
| Poster / Family Photo | wall | Cosmetic. Ambience + a trickle of Family. |
| Prayer Mat | 1x1 | Spirituality, in-cell. |
| Barred Window | wall | Fills Outdoors slowly without leaving. Doesn't block sight. |

### Gym & common room

| Object | Size | Effect |
| --- | --- | --- |
| Weight Bench | 2x1 | Exercise, heavy Strength. |
| Squat Rack / Dumbbell Rack | 1x1 | Exercise, Strength. Plates are blunt weapons. |
| Treadmill / Exercise Bike / Rower | 1x1 | Exercise. Needs power. |
| Exercise Mat | 2x2 | Exercise, cheap, no power. |
| Pool Table | 2x1 | Recreation, 2 users. Cues are weapons. |
| Table Tennis / Foosball | 2x1 | Recreation, 2 users. |
| Television | 1x1 | Recreation for everyone seated facing it — a use-slot that serves a crowd. |
| Sofa | 2x1 | Sit. Comfort + Recreation when facing a TV. |
| Arcade Cabinet / Jukebox | 1x1 | Recreation. Needs power. |
| Board Game Table | 2x1 | Recreation + Intelligence, 4 users. |
| Dartboard | wall | Recreation. Darts are contraband. |

### Staff room

| Object | Size | Effect |
| --- | --- | --- |
| Staff Sofa | 2x1 | Sit. Restores staff Fatigue. |
| Coffee Machine | 1x1 | Fast Fatigue refill. The single highest-value staff object. |
| Vending Machine | 1x1 | Staff hunger, no cook needed. |
| Staff TV | 1x1 | Morale. What off-duty guards actually do. |
| Lockers | 1x1 | Shift change; guards collect batons and radios here. |
| Water Cooler | 1x1 | Small refill. Two staff standing at it is the classic idle animation. |
| Notice Board / Magazine Rack | wall | Cosmetic. Ambience. |
| Kettle / Microwave / Fridge / Sink | 1x1 | Cosmetic-to-functional staff kitchenette. |

### Kitchen & canteen

| Object | Size | Effect |
| --- | --- | --- |
| Oven | 2x1 | The large tier of Cooker — more meals per cook cycle. |
| Fridge / Freezer | 1x1 | Stores ingredients; without one, deliveries spoil. |
| Prep Table | 2x1 | Cooks prep here before the hob. Raises food quality. |
| Knife Block | 1x1 | Contraband source. A kitchen job is how a prisoner gets a shiv. |
| Sink / Dishwasher | 1x1 | Dirty trays pile up without one; ambience falls. |
| Food Crate / Pantry | 1x1 | Ingredient storage. Deliveries fill it. |
| Extractor Hood | 1x1 | Cosmetic; without it, kitchen fire risk. |
| Serving Cart | 2x1 | Mobile serving table — feeds a locked-down block in place. |
| Drink Dispenser / Salad Bar | 1x1 | Food quality, ambience. |

### Security

| Object | Size | Effect |
| --- | --- | --- |
| CCTV Camera | wall | Writes into staff shared memory exactly as a guard's vision cone does — an eye that never blinks. |
| CCTV Monitor Bank | 2x1 | A guard must man it, or cameras see nothing. |
| Door Control Desk | 2x1 | Remote-locks jail doors from the security room. |
| Metal Detector | door | A door frame. Flags `cutters` and shivs on anyone passing. |
| Sniffer Dog Post | 1x1 | Dogs detect drugs — and **tunnels**, walking over unflagged ones. |
| Searchlight | 1x1 | Sweeping cone at night. Raises the odds a climber is spotted. |
| Alarm / Siren | wall | Triggers lockdown; every guard converges. |
| Razor Wire | on fence | Upgrades a fence tile: climbing takes far longer and injures. |
| Perimeter Wall | wall mat | Unclimbable. Forces cutting or digging — pushes prisoners toward tunnels. |

### Cosmetics — and why they're mechanical

Give every object an **ambience** value; a room's ambience is the sum of its objects over its
area. Ambience multiplies need refill rates in that room and feeds mood. Cosmetics now have a
real number attached, and decorating becomes a strategy rather than a screenshot mode — for the
price of a single float in the object table.

| Object | Size | Note |
| --- | --- | --- |
| Potted Plant / Large Plant | 1x1 | The small/large tier again. Big ambience indoors. |
| Rug / Carpet | 1x1+ | Walkable. Warms an institutional room. |
| Painting / Framed Photo | wall | Ambience. Classic contraband hiding place. |
| Wall Clock / Notice Board / Exit Sign | wall | Institutional texture. |
| Curtains / Blinds | wall | Staff areas only. Blocks sight lines. |
| Radiator / Vent / Exposed Pipes | 1x1 | Ambience; pipes hint at the utility layer. |
| Fire Extinguisher / First Aid Box | wall | Cosmetic until fires and injuries exist — then not. |
| Graffiti | wall decal | Appears on its own in low-ambience blocks. Ambience that fights back. |

### New floors & walls

- **Floors:** carpet, tile, checkerboard tile, turf, gravel, asphalt, running track, court lines, dirt, marble.
- **Walls:** brick, painted plaster, tile, glass/window wall, barred window, perimeter concrete, razor wire, electric fence.
- **Doors:** reinforced, sally port, remote-controlled, staff-only, glass, metal-detector frame.

---

## Part 5 — Staff

Every `Agent` — guards, cooks and workmen included — already carries a full `needs` record.
**Nothing reads it.** That is a staff-needs system sitting there fully allocated and unused.

A staff room only means something if staff can be *off duty*. So the enabling feature is a
**shift roster**: each staff member is on-duty, on-break, or off-shift. On break they walk to the
staff room, sit on the sofa, use the coffee machine, and stand around the water cooler until the
break ends — "staff not doing anything, passing time", reusing the same generic use-slot pathway
as a prisoner watching TV.

| Staff need | Filled by | Consequence if starved |
| --- | --- | --- |
| **Fatigue** | Staff room sofa, coffee machine | Slower patrol, wider vision gaps, missed spots |
| **Hunger** | Staff canteen, vending machine | Leaves post to find food, unprompted |
| **Morale** | Wages, staff TV, ambience, low danger | Quits. Below a threshold, walks out mid-shift |

### New staff

| Role | Job | Cost |
| --- | --- | --- |
| Janitor | Cleans mess, empties bins, restores ambience. Reuses the workman's job-claim loop wholesale. | [data] |
| Doctor | Treats injuries in the infirmary. | [sys] |
| Teacher | Runs classes; raises Intelligence. | [sys] |
| Chaplain | Mans the chapel; raises Reform. | [sys] |
| Librarian | Mans the library; faster Intelligence gain. | [data] |
| Foreman | Supervises the workshop; without one, tools walk. | [sys] |
| Dog Handler | Patrols with a dog; sniffs out tunnels and drugs. | [BIG] |
| Riot Guard | Armoury-equipped; only deploys on lockdown. | [sys] |
| Visitor | A civilian who walks in, sits in a booth, leaves — and may pass something across the table. | [BIG] |

### Prisoner jobs

A prisoner with a job is a prisoner with somewhere to be. Jobs pay, raise Reform, and drain the
idle hours that feed `escapeDesire` — but every job puts a man next to something sharp. The
`cutters` and `spoons` counters already exist and already gate the cut and dig plans; jobs are
the supply line that fills them.

- **Kitchen hand** — knives. The fastest route to a fence-cutter.
- **Workshop labourer** — saws, files. Pays best, arms best.
- **Gardener** — shovels. Direct fuel for the tunnel system.
- **Laundry worker** — safe, dull, low pay. The job you give the risky ones.
- **Cleaner** — roams the whole prison. Excellent for scouting; a cleaner's memory map fills fast.
- **Library assistant** — safe, raises Intelligence.

> The player must staff the jobs that create contraband in order to run the prison at all. Every
> job assignment is a wager: this man will be calmer, richer and more reformed — and he will be
> standing next to a saw for six hours a day. No new systems. The ones you already wrote, pointed
> at each other.

---

## Part 6 — Regime

Six activities today on a 24h clock. Each new one is an enum entry plus a branch in the
compliance check.

| Activity | What prisoners do | Cost |
| --- | --- | --- |
| Work | Go to your assigned job. Money, Reform, contraband exposure. | [sys] |
| Recreation | Common room, library, chapel — whatever fills the loudest need. | [data] |
| Exercise | Gym or yard equipment. | [data] |
| Education | Class, if a teacher is present. | [sys] |
| Visitation | Visitors arrive; prisoners queue for booths. | [BIG] |
| Roll Call | Every prisoner reports to a muster point; guards count. | [sys] |
| Shakedown | Guards search cells and footlockers for contraband. | [sys] |
| Lockdown | Emergency. All doors shut, all prisoners to cells. | [sys] |

> **Roll call is the missing half of the escape system.** You have escapes and `escapedCount`.
> What you don't have is a moment where the prison *notices*. Roll call is that moment — a
> scheduled hour when every prisoner must be countable, and a man in a tunnel is a man who isn't
> there.
>
> It also makes tunnelling tactical rather than merely slow: a digger has to be back in his bunk
> by the count, so an escape must be timed against the regime the player wrote themselves.

---

## Part 7 — Order of work

1. **The unlock layer** — object table, footprints, use-slots, generic memory. Nothing visible ships. Everything after gets cheap.
2. **Content flood** — library, gym, common room, chapel, staff room. Recreation, Exercise, Bladder. Every cosmetic + the ambience score. The game visibly triples in size; almost entirely authoring.
3. **Staff shifts** — on-duty / on-break / off-shift, wired to the `needs` record that already exists. The staff room starts doing its job.
4. **Stats and the enrichment dilemma** — Strength and Intelligence into `CLIMB_TIME` and `TUNNEL_DRIFT`. The library and gym stop being charity and start being a gamble.
5. **Jobs, contraband and the count** — jobs as the supply line for `cutters`/`spoons`. Shakedowns and metal detectors as counter-play. Roll call as the moment the prison notices.
6. **The heavy systems** — power and water, cameras and the security room, visitation, dogs, riots. One at a time, and only once 1–5 are solid.
