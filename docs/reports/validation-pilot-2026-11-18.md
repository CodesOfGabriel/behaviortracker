# Piloto de referência humana

Seleção: `validation-pilot-temporal-strata-1`; semente: `20261118`.
Meta: 300 frames e 20 clipes.
Amostragem distribuída por gravação e tempo; categorias de comportamento aguardam revisão humana.
O holdout reserva uma gravação inteira e seus rótulos não devem orientar ajustes dos filtros.

| Gravação | Protocolo | Partição | SHA-256 do vídeo | Frames | Clipes |
| --- | --- | --- | --- | ---: | ---: |
| oft_01 | open_field | development | `67f3e8eba5c1af4f192d8f226a37f286e6998f962d306306d8c9ff678d05aa5a` | 60 | 5 |
| oft_02 | open_field | holdout | `e8cd0c3a5624a4342346fcf56a328e8a86419cf058d27cccf1bea1a6141e51c4` | 60 | 4 |
| oft_03 | open_field | development | `53f45629b5c6545ad29b03c5b6e9383e7bf2fd53ac657ea7f0af8a4d2afa9ef0` | 60 | 4 |
| fst_01 | forced_swim | development | `95b6a883b23e961d39d2a70a1f5c46f26856fcae17db58a2190b80a138de39b0` | 60 | 4 |
| ram_clip_01 | radial_arm_maze | development | `b0209e8c09fdc96879818fee3c104474efb507db763552528fe6805392ef05e5` | 60 | 3 |

Os PTS de cada frame vêm de `ffprobe -show_frames`. Os clipes têm listas completas de frames no JSON.
O piloto não contém coordenadas humanas, rótulos de eventos ou estimativa de suficiência estatística.
