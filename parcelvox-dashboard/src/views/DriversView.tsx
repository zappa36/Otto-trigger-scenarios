import { DRIVERS } from '../data/drivers';
import shared from '../styles/shared.module.css';

const COLUMNS = '1.4fr 1fr .8fr .9fr 1.3fr 1fr';

export function DriversView() {
  return (
    <div className={shared.page} style={{ maxWidth: 1000 }}>
      <h1 className={shared.h1}>Drivers</h1>
      <p className={shared.lede} style={{ marginBottom: 16 }}>
        What each driver adds to the shared knowledge base.
      </p>

      <div className={shared.note} style={{ marginBottom: 18 }}>
        This page shows contribution only. ParcelVox keeps no records of pace, speed, or stops per
        hour.
      </div>

      <div className={shared.table}>
        <div className={shared.thead} style={{ gridTemplateColumns: COLUMNS }}>
          <span>Driver</span>
          <span>Routes covered</span>
          <span>Tips shared</span>
          <span>Tips accepted</span>
          <span>Acceptance</span>
          <span>Last debrief</span>
        </div>

        {DRIVERS.map((driver) => (
          <div key={driver.name} className={shared.row} style={{ gridTemplateColumns: COLUMNS }}>
            <span className={shared.cellStrong}>{driver.name}</span>
            <span className={shared.cellMuted}>{driver.routesCovered}</span>
            <span>{driver.tipsShared}</span>
            <span>{driver.tipsAccepted}</span>
            <span className={shared.meter}>
              <span className={shared.meterTrack}>
                <span className={shared.meterFill} style={{ width: `${driver.acceptance}%` }} />
              </span>
              <span className={shared.meterValue}>{driver.acceptance}%</span>
            </span>
            <span className={shared.cellMuted}>{driver.lastDebrief}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
