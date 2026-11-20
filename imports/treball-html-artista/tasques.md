# Treball HTML + CSS: Web d'un artista o grup musical

Fitxer per importar les tasques al Kanban (pestanya Tasques, «Importa des de Markdown»).
Aquest text d'abans de la primera tasca no s'importa. La descripció general del treball
és al fitxer descripcio.md, per enganxar-la a la descripció del projecte.

---

## Preparar GitHub

**Tags:** GitHub

**Requeriments:**

- Crear un repositori anomenat `DAM1M04-TreballHTML`.
- Crear la branca principal `main`.
- Crear una branca secundària per a cada alumne del grup.
- Afegir els dos alumnes com a col·laboradors.
- Crear un fitxer `README.md` amb el nom de l'artista, la descripció i els integrants.
- Crear les tasques del projecte com a GitHub Issues.
- Integrar els canvis a `main` mitjançant Pull Requests.

---

## Preparar l'estructura del projecte

**Tags:** HTML, CSS

**Requeriments:**

- Crear les cinc pàgines HTML: `index.html`, `musica.html`, `historia.html`, `concerts.html` i `contacte.html`.
- Crear les carpetes necessàries per organitzar CSS, imatges i altres recursos.
- Utilitzar rutes relatives per als recursos locals.
- Separar completament el codi HTML del CSS.
- Organitzar els CSS amb criteris de reutilització.
- NO es pot fer servir Grid.
- NO es pot fer servir l'atribut `style`.

---

## Dissenyar la identitat visual

**Tags:** CSS, Disseny

**Requeriments:**

- Definir una paleta de colors relacionada amb l'estil musical de l'artista.
- Utilitzar almenys una tipografia de Google Fonts.
- Crear una identitat visual pròpia amb logotip, colors i estils coherents.
- Dissenyar botons, targetes i altres components reutilitzables.
- Mantenir la mateixa estètica a totes les pàgines.

---

## Crear el Header i el menú de navegació

**Tags:** HTML, CSS, Interactivitat

**Requeriments:**

- Mostrar el nom de l'artista o grup i el seu logotip.
- Crear un menú amb enllaços a les cinc pàgines.
- Destacar visualment la pàgina activa.
- Adaptar el menú a dispositius mòbils.
- Implementar un menú desplegable per a mòbils sense JavaScript, utilitzant `checkbox` i `:checked`.
- Animar l'obertura i el tancament del menú amb transicions CSS.

---

## Crear el Footer

**Tags:** HTML, CSS

**Requeriments:**

- Mostrar un text de copyright alineat a la dreta.
- Afegir enllaços a Instagram, TikTok, YouTube i Spotify.
- Utilitzar icones vectorials o una biblioteca d'icones.
- Aplicar efectes `:hover` als enllaços de les xarxes socials.
- Utilitzar el mateix disseny de Footer a totes les pàgines.

---

## Pàgina principal (index.html)

**Tags:** HTML, CSS, Animacions

**Requeriments:**

- Crear un Hero amb una fotografia de l'artista, un eslògan i un botó destacat.
- Mostrar una secció promocional del darrer àlbum o senzill.
- Crear una secció amb les principals novetats de l'artista.
- Incorporar una animació associada al desplaçament vertical de la pàgina (*scroll-driven animation*).
- Incorporar una animació vectorial SVG o Lottie.
- Afegir un botó o interruptor que permeti activar i desactivar una animació del Hero sense JavaScript.

---

## Pàgina de música (musica.html)

**Tags:** HTML, CSS, Interactivitat

**Requeriments:**

- Mostrar una discografia amb almenys quatre àlbums o senzills.
- Presentar les portades en una distribució CSS flexbox.
- Incloure el títol, l'any de publicació i una breu descripció de cada àlbum.
- Incorporar almenys un reproductor de Spotify, YouTube o un element HTML5 `audio`.
- Crear targetes amb efectes animats en passar el ratolí per sobre (`:hover`).
- Implementar un sistema de pestanyes per alternar entre àlbums i senzills utilitzant `radio` i `:checked`, sense JavaScript.

---

## Pàgina d'història (historia.html)

**Tags:** HTML, CSS, Animacions, Interactivitat

**Requeriments:**

- Explicar l'origen i la trajectòria de l'artista.
- Crear una línia temporal amb els principals esdeveniments de la seva carrera.
- Afegir fotografies, il·lustracions o imatges relacionades amb cada etapa.
- Implementar un carrusel d'imatges interactiu sense JavaScript.
- Aplicar animacions CSS a les imatges o als elements de la línia temporal.
- Incorporar transicions suaus entre els diferents elements del carrusel.

---

## Pàgina de concerts (concerts.html)

**Tags:** HTML, CSS, Interactivitat

**Requeriments:**

- Mostrar una llista de concerts amb data, ciutat, recinte i disponibilitat d'entrades.
- Presentar els concerts amb targetes o una distribució adaptativa.
- Incloure almenys sis concerts, reals o ficticis.
- Destacar visualment els concerts esgotats.
- Afegir botons per consultar o comprar entrades, que poden ser enllaços ficticis.
- Implementar filtres interactius per mostrar tots els concerts, els pròxims concerts o els concerts esgotats, sense JavaScript.
- Animar els canvis d'estat dels controls amb CSS.

---

## Pàgina de contacte (contacte.html)

**Tags:** HTML, CSS, Formularis

**Requeriments:**

- Mostrar una adreça de contacte, real o fictícia.
- Incorporar un mapa de Google Maps.
- Mostrar un telèfon amb un enllaç `tel:`.
- Mostrar una adreça electrònica amb un enllaç `mailto:`.
- Crear un formulari amb els camps: nom, telèfon, correu electrònic, motiu de contacte i missatge.
- Validar els camps mitjançant HTML5 i expressions regulars amb `pattern` quan correspongui.
- Canviar automàticament l'aspecte dels camps segons si són vàlids o invàlids, amb `:valid` i `:invalid`.
- Incorporar animacions o transicions als camps quan rebin el focus (`:focus`).
- No és necessari que el formulari enviï les dades a un servidor.

---

## Interactivitat i control d'animacions

**Tags:** CSS, Animacions, Interactivitat

**Requeriments:**

- Incorporar almenys tres animacions CSS amb `@keyframes` en diferents elements de la web.
- Implementar transicions amb `transition`.
- Utilitzar transformacions CSS com `scale`, `translate` o `rotate`.
- Crear almenys dos controls que permetin activar i desactivar efectes visuals mitjançant `checkbox`, `radio` i `:checked`.
- Implementar almenys una interacció amb `:hover` i una altra amb `:focus`.
- Utilitzar `animation-play-state` per pausar i reprendre alguna animació.
- Respectar la preferència `prefers-reduced-motion` per reduir les animacions quan l'usuari ho sol·liciti.

Tota la interactivitat d'aquesta tasca s'ha de desenvolupar sense JavaScript.

---

## Adaptar la web a mòbils

**Tags:** CSS, Responsive

**Requeriments:**

- Utilitzar Flexbox per distribuir els continguts.
- Adaptar les cinc pàgines a pantalles de mòbil i ordinador.
- Utilitzar Media Queries per modificar la distribució segons l'amplada.
- Evitar el desplaçament horitzontal no desitjat.
- Comprovar que els menús, carrusels, formularis i altres elements interactius funcionen en pantalles tàctils.
- Garantir una mida adequada dels botons i una bona llegibilitat dels textos.

---

## Revisar i millorar el projecte

**Tags:** Qualitat

**Requeriments:**

- Comprovar que tots els enllaços funcionen correctament.
- Revisar el codi HTML i CSS.
- Eliminar codi innecessari o duplicat.
- Comprovar que les imatges tenen text alternatiu (`alt`).
- Verificar que els controls interactius es poden utilitzar amb el teclat.
- Comprovar que totes les pàgines mantenen una estètica coherent.
- Provar la web en almenys dos navegadors diferents.

---

## Publicar la web a Proxmox

**Tags:** Proxmox

**Requeriments:**

- Publicar la web en un servidor del Proxmox.
- Comprovar que les cinc pàgines són accessibles.
- Verificar que es carreguen correctament els CSS, les imatges i els altres recursos.
- Actualitzar el `README.md` amb les instruccions del projecte i l'URL de la web publicada.

---

## Lliurar el projecte

**Tags:** Lliurament, GitHub, Proxmox

**Requeriments:**

- Tenir tots els canvis integrats a la branca `main`.
- Tenir totes les tasques de GitHub Issues completades i tancades.
- Tenir la web publicada i accessible al servidor Proxmox.
- Lliurar al Moodle l'enllaç del repositori de GitHub.
- Lliurar al Moodle l'enllaç de la web publicada.
- Identificar els dos integrants de l'equip.

**Entrega:**

- El repositori és d'un dels dos alumnes i ha de tenir aportacions de tots dos.
- La web s'ha de poder veure al Proxmox de l'institut, al servidor d'un dels dos alumnes.
- Cada alumne del grup ha d'entregar les mateixes dues URL (GitHub i Proxmox) al seu Moodle personal.
